/**
 * Turning on `@zosmaai/pi-llm-wiki`'s semantic recall.
 *
 * The package ships a complete embedding path — page vectors precomputed at
 * write time into `meta/embeddings.json`, a single cached query embedding per
 * recall, cosine fused into the ranking — and it is dormant unless a provider
 * is configured. `TASK_DEFAULTS` is `{}`, so `resolveEmbedder` returns
 * undefined, `searchWikiHybrid` takes its no-embeddings branch, and every
 * result the agent has ever seen came from lexical substring matching. Nothing
 * reports this: the fallback is the documented graceful degradation.
 *
 * **Why OpenRouter.** It is the only provider in Semla's agent directory, so
 * the wiki needs no second vendor and no second key; `code-index/embed.ts`
 * established by probing that its `/api/v1/embeddings` is OpenAI wire
 * compatible, and says in as many words that this package's embedder can be
 * pointed at the same endpoint with the same credential. The model name and
 * base URL are imported from there rather than repeated, so the wiki and the
 * code index cannot drift onto different models.
 *
 * **Why the agent directory and not a project settings file.** `loadTaskConfig`
 * merges a global file from `getAgentDir()` with project files under the cwd it
 * is handed — and the package hands it two different cwds: `index.ts` calls
 * `ensureConfig(process.cwd())` while `launchEmbedPages` calls
 * `ensureConfig(paths.root)`, the vault root. A project-scoped file would
 * therefore configure recall and leave write-time indexing unconfigured, or the
 * reverse. The global file is the only location every call site agrees on. It
 * is also the only one available: a `.pi/` directory in this repository is what
 * `pi-dir-removed.test.ts` exists to prevent.
 *
 * That makes the settings file machine-local, so the values live here as a
 * versioned constant and are materialised into the agent directory at boot —
 * the same shape as `agent-dir.ts` seeding `auth.json`. The file is an artifact
 * of this module, not a place to configure anything by hand.
 *
 * **Why the key travels in the environment.** The package reads
 * `config.embeddingApiKey` or `process.env[config.embeddingApiKeyEnv]`, and its
 * own comment asks callers to prefer the env var so the secret stays out of a
 * settings file. The credential is still sourced from `auth.json`, which
 * remains the single place Semla resolves an OpenRouter key from; this only
 * hands it to an in-process consumer that cannot read it there itself.
 * `launchEmbedPages` runs on `runtime.launchTask` in this same process, so
 * there is no child to inherit it.
 *
 * Absent credentials are not an error, matching `resolveEmbedder` in
 * `code-index/credentials.ts`: recall keeps working lexically.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { readOpenRouterKey } from "@/lib/code-index/credentials";
import { DEFAULT_EMBEDDING_BASE_URL, DEFAULT_EMBEDDING_MODEL } from "@/lib/code-index/embed";
import { PI_AGENT_DIR } from "@/lib/pi/runtime/agent-dir";

/**
 * Env var the wiki's embedder reads its key from.
 *
 * Named for Semla rather than reusing `OPENROUTER_API_KEY`, the package's
 * `OPENAI_API_KEY` default, or anything else a developer may already have set:
 * this value is written into the process by the line below and read by exactly
 * one consumer, and a collision would mean an unrelated variable silently
 * deciding which credential the wiki embeds with.
 */
export const WIKI_EMBEDDING_KEY_ENV = "SEMLA_WIKI_EMBEDDING_API_KEY";

/** The key `loadTaskConfig` reads this extension's settings out of. */
export const WIKI_SETTINGS_SECTION = "llm-wiki";

/**
 * The `llm-wiki` settings this repository asserts.
 *
 * `openai-compatible` rather than `openai` because the endpoint is
 * OpenRouter's; `resolveEmbedder` accepts either and treats them identically.
 */
export const WIKI_EMBEDDING_SETTINGS = {
  embeddingProvider: "openai-compatible",
  embeddingBaseUrl: DEFAULT_EMBEDDING_BASE_URL,
  embeddingModel: DEFAULT_EMBEDDING_MODEL,
  embeddingApiKeyEnv: WIKI_EMBEDDING_KEY_ENV,
} as const;

export interface WikiEmbeddingSetup {
  /** True when a credential was found and the settings file now asserts it. */
  configured: boolean;
  /** The settings file that was read, and written if it disagreed. */
  settingsPath: string;
  /** Embedding model the vault will be indexed against. */
  model: string;
  /** True when this call changed the file on disk. */
  written: boolean;
  /** Why semantic recall stays off, when `configured` is false. */
  reason?: string;
}

function readSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    // A settings file we cannot parse is pi's to repair, not ours to overwrite:
    // it holds the model picker's defaults and the package list too.
    return {};
  }
}

/**
 * Publish the embedding credential into the process and assert the `llm-wiki`
 * settings section in Semla's agent directory.
 *
 * Idempotent, and writes only when the file disagrees, so a boot on an
 * already-configured machine touches nothing.
 */
export function configureWikiEmbeddings(
  options: { agentDir?: string } = {},
): WikiEmbeddingSetup {
  const agentDir = options.agentDir ?? PI_AGENT_DIR;
  const settingsPath = join(agentDir, "settings.json");
  const model = WIKI_EMBEDDING_SETTINGS.embeddingModel;

  const apiKey = readOpenRouterKey(agentDir);
  if (apiKey === null) {
    return {
      configured: false,
      settingsPath,
      model,
      written: false,
      reason: `no openrouter credential in ${join(agentDir, "auth.json")}`,
    };
  }

  process.env[WIKI_EMBEDDING_KEY_ENV] = apiKey;

  const settings = readSettings(settingsPath);
  const existing = settings[WIKI_SETTINGS_SECTION];
  const section: Record<string, unknown> =
    typeof existing === "object" && existing !== null
      ? { ...(existing as Record<string, unknown>) }
      : {};

  let changed = false;
  for (const [key, value] of Object.entries(WIKI_EMBEDDING_SETTINGS)) {
    if (section[key] === value) continue;
    section[key] = value;
    changed = true;
  }

  if (changed) {
    settings[WIKI_SETTINGS_SECTION] = section;
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
  }

  return { configured: true, settingsPath, model, written: changed };
}

/** One line for the boot log, so a lexical-only vault is traceable to here. */
export function describeWikiEmbeddings(setup: WikiEmbeddingSetup): string {
  if (!setup.configured) {
    return `[wiki] semantic recall off: ${setup.reason}. Recall stays lexical.`;
  }
  return (
    `[wiki] semantic recall configured: ${setup.model}` +
    `${setup.written ? ` (wrote ${setup.settingsPath})` : ""}`
  );
}
