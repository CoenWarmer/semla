/**
 * Wiki tools for workflow subagents.
 *
 * A subagent's tool set is `createCodingTools(cwd)` — bash/read/edit/write —
 * plus whatever a named toolset adds. The wiki extension registers its tools on
 * the *host* session only, so a subagent never sees them. The model has no way
 * to know that: it sees `wiki_capture_source` in its own tool set and assumes a
 * subagent it spawns has it too.
 *
 * That assumption cost a real orient run 23 minutes and $8.90. Six subagents
 * were told to capture a facet each; all six reported the tool missing. Four
 * improvised through bash — one re-implemented capture by hand, another
 * imported the package's internal `captureText` and burned 3.19M input tokens
 * doing it — and two gave up, so their facets were never captured at all. The
 * hand-rolled captures also wrote manifests with no `file_path`, which is what
 * defeats pi-llm-wiki's own repo derivation (see wiki-repo-stamp.ts).
 *
 * Registering the tools as a named toolset closes the gap: a workflow that asks
 * for `toolset: "wiki"` gets the real tools, and the fan-out that was always
 * the point of an orient run actually works.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { stampRepoFrontmatter } from "./wiki-frontmatter.js";
import { withVaultLock } from "./wiki-vault-lock.js";

/** Toolset tag a workflow passes to reach these tools. */
export const WIKI_SUBAGENT_TOOLSET = "wiki";

/**
 * Wiki tools a subagent may hold, mapped to the package function that registers
 * each one. Read/append operations scoped to a single source or page: exactly
 * what a fan-out agent needs to do its share of the work.
 */
export const WIKI_SUBAGENT_REGISTRARS: Readonly<Record<string, string>> = {
  wiki_capture_source: "registerWikiCaptureSource",
  wiki_ensure_page: "registerWikiEnsurePage",
  wiki_search: "registerWikiSearch",
  wiki_status: "registerWikiStatus",
  wiki_log_event: "registerWikiLogEvent",
};

export const WIKI_SUBAGENT_TOOL_NAMES: readonly string[] = Object.keys(
  WIKI_SUBAGENT_REGISTRARS,
);

/**
 * Wiki tools deliberately withheld, and why. Kept as data rather than a comment
 * so the reasoning survives the next person who wonders where `wiki_ingest`
 * went, and so a test can assert the two sets never overlap.
 */
export const WIKI_TOOLS_WITHHELD_FROM_SUBAGENTS: Readonly<
  Record<string, string>
> = {
  wiki_ingest:
    "Starts a background synthesis workflow. A subagent calling it nests a run outside the parent's concurrency, budget and accounting — the same recursion that workflow/workflow_control are denied for.",
  wiki_reindex_embeddings:
    "The bridge turns this into its own workflow run, so it recurses for the same reason as wiki_ingest.",
  wiki_bootstrap:
    "Initialises the whole vault. Parallel subagents would race to create the same scaffold.",
  wiki_rebuild_meta:
    "Rewrites every derived file from every page. Concurrent rebuilds interleave and can publish a half-built registry.",
  wiki_watch:
    "Starts a long-lived watcher with no owner once the subagent that started it exits.",
};

const WIKI_TOOLS_MODULE = join(
  process.cwd(),
  ".pi/npm/node_modules/@zosmaai/pi-llm-wiki/extensions/llm-wiki/lib/tools.ts",
);

/**
 * Declared for wiki-package-contract.test.ts: the path is a computed string so
 * tsc cannot check it, and a release that renames a registrar would leave
 * subagents silently toolless again.
 */
export const WIKI_SUBAGENT_DEEP_IMPORTS: ReadonlyArray<{
  path: string;
  exports: readonly string[];
}> = [
  {
    path: WIKI_TOOLS_MODULE,
    exports: Object.values(WIKI_SUBAGENT_REGISTRARS),
  },
];

/**
 * Tools that write to the vault, and so must not run concurrently.
 *
 * The registrars are called without a Runtime — deliberately, since
 * pi-llm-wiki's Runtime launches its own background tasks, which the workflow
 * run owning the subagent neither tracks nor outlives. The cost is that
 * capture and ensure_page take their no-Runtime branch and call
 * rebuildMetadataLight synchronously: a full rebuild of every derived file,
 * per call, without scheduleReindex's single-flight coalescing. Six capture
 * agents in parallel would each rebuild the whole vault from a different
 * mid-flight snapshot and the last writer would win — the same race
 * wiki_rebuild_meta is withheld for.
 */
const VAULT_WRITING_TOOLS = new Set([
  "wiki_capture_source",
  "wiki_ensure_page",
  "wiki_log_event",
]);

/** Minimal shape this module needs from a registered tool. */
interface NamedTool {
  name: string;
}

interface ExecutableTool extends NamedTool {
  execute?: (...args: never[]) => unknown;
}

/**
 * Keep only the tools a subagent is allowed to hold.
 *
 * Separated from the collection below so the policy is testable without the
 * package installed — the filter, not the import, is the part with a decision
 * in it.
 */
export function selectSubagentTools<T extends NamedTool>(tools: T[]): T[] {
  const allowed = new Set(WIKI_SUBAGENT_TOOL_NAMES);
  const seen = new Set<string>();
  return tools.filter((tool) => {
    if (!allowed.has(tool.name) || seen.has(tool.name)) return false;
    seen.add(tool.name);
    return true;
  });
}

export interface VaultGuardOptions {
  wikiHome: string;
  /** The repo of the session these tools belong to, resolved per call. */
  repoOf: () => string | null;
}

/**
 * Reject a capture that names something the fetcher cannot fetch.
 *
 * `wiki_capture_source` takes url | file_path | text, and `url` is first in
 * both the schema and the description ("Capture a URL, local file, or pasted
 * text"). A subagent capturing local code and given no steer picks it, and the
 * package then runs the *web* extractor over whatever it was handed: an orient
 * run captured `/Users/coen/Dev/semla/README.md` as a URL and stored
 * "Content could not be extracted", and another fetched a GitHub 404 page —
 * both recorded as sources and both on their way into entity pages.
 *
 * Only obviously-unfetchable values are refused. A real http(s) URL still
 * works, because capturing a genuine web page is a legitimate use.
 */
export function rejectUnfetchableUrl(
  params: unknown,
): { content: Array<{ type: "text"; text: string }>; isError: true } | null {
  const url = (params as { url?: unknown } | null)?.url;
  if (typeof url !== "string" || url.trim() === "") return null;

  let scheme: string;
  try {
    scheme = new URL(url).protocol;
  } catch {
    scheme = "";
  }
  if (scheme === "http:" || scheme === "https:") return null;

  return {
    content: [
      {
        type: "text" as const,
        text:
          `wiki_capture_source: "${url}" is not a fetchable URL. ` +
          "To capture a local file, read it and pass its contents as `text` " +
          "with a `title`, or pass the path as `file_path` — not as `url`.",
      },
    ],
    isError: true,
  };
}

const sourcePages = (wikiHome: string): string[] => {
  try {
    return readdirSync(join(wikiHome, ".llm-wiki", "wiki", "sources"));
  } catch {
    return [];
  }
};

/**
 * Attribute the source pages a capture just created.
 *
 * Called with the vault lock held, so "which files are new" is a real answer
 * rather than a guess — no other capture can be part-way through. Attributing
 * here rather than at turn end is what makes concurrent orients correct: a
 * source belongs to the session that captured it, not to whichever session's
 * turn happened to end first.
 */
function attributeNewSources(wikiHome: string, before: Set<string>, repo: string): void {
  const dir = join(wikiHome, ".llm-wiki", "wiki", "sources");
  for (const entry of sourcePages(wikiHome)) {
    if (before.has(entry) || !entry.endsWith(".md")) continue;
    const path = join(dir, entry);
    try {
      const outcome = stampRepoFrontmatter(readFileSync(path, "utf8"), repo);
      if (outcome.changed) writeFileSync(path, outcome.content, "utf8");
    } catch {
      // The turn-end sweep still covers this page, just less precisely.
    }
  }
}

/**
 * Hold the vault lock across every write, and attribute captures as they land.
 *
 * Without a Runtime the package's capture and ensure_page tools rebuild every
 * derived file inline, and `nextSequentialId` allocates source ids by listing a
 * directory and adding one. Two sessions doing either at once lose data: the
 * later rebuild publishes a registry built before the other's pages existed,
 * and two captures can claim the same id, the second silently overwriting the
 * first. The lock is filesystem-based because the sessions it separates need
 * not share a process.
 */
export function guardVaultWrites<T extends ExecutableTool>(
  tools: T[],
  options: VaultGuardOptions,
): T[] {
  // A capture that lands with no repo is not fatal — the turn-end sweep still
  // attributes it — so this failed completely silently once already, when the
  // session→repo map was keyed on the wrong id and every lookup missed. Said
  // once per session, because the quiet fallback is exactly what hid it.
  let warnedNoRepo = false;

  return tools.map((tool) => {
    if (!VAULT_WRITING_TOOLS.has(tool.name) || typeof tool.execute !== "function") {
      return tool;
    }

    const execute = tool.execute.bind(tool);
    const isCapture = tool.name === "wiki_capture_source";

    return {
      ...tool,
      execute: (...args: never[]) => {
        // args are (toolCallId, params, signal, onUpdate, ctx).
        const refusal = isCapture ? rejectUnfetchableUrl(args[1]) : null;
        if (refusal) return Promise.resolve(refusal);

        return withVaultLock(options.wikiHome, tool.name, async () => {
          const before = isCapture ? new Set(sourcePages(options.wikiHome)) : null;
          const result = await execute(...args);
          const repo = options.repoOf();
          if (before && repo) {
            attributeNewSources(options.wikiHome, before, repo);
          } else if (before && !warnedNoRepo) {
            warnedNoRepo = true;
            console.warn(
              "[wiki-bridge] captured a source with no repo for this session. " +
                "Attribution falls back to the turn-end sweep, which is not safe " +
                "when two orients share a vault.",
            );
          }
          return result;
        });
      },
    };
  });
}

/**
 * Build the wiki tool definitions for subagents.
 *
 * The package's registrars only ever call `pi.registerTool`, so handing them a
 * proxy of the real ExtensionAPI that collects instead of registering yields
 * the genuine tool definitions — same parameters, same execute — without
 * touching the host session's tool set. Everything else falls through to the
 * real `pi`, which matters because capture-by-URL reaches back through it.
 */
export async function collectWikiSubagentTools<T extends ExecutableTool>(
  pi: object,
  guard: VaultGuardOptions,
): Promise<T[]> {
  const registrars = (await import(WIKI_TOOLS_MODULE)) as Record<
    string,
    ((collector: object) => void) | undefined
  >;

  const collected: T[] = [];
  const collector = {
    ...pi,
    registerTool: (tool: T) => {
      collected.push(tool);
    },
  };

  for (const registrar of Object.values(WIKI_SUBAGENT_REGISTRARS)) {
    registrars[registrar]?.(collector);
  }

  return guardVaultWrites(selectSubagentTools(collected), guard);
}
