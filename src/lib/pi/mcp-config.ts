/**
 * Pins pi-mcp-adapter to exactly one configuration file, inside Semla's own
 * agent directory — never a file written for a different tool.
 *
 * An MCP server entry is a `command` and its `args`: arbitrary process
 * execution, described in a file. pi-mcp-adapter's default config loading
 * *merges* up to six sources by precedence (see docs/plans/mcp-servers.md §5),
 * two of which are host-global and outrank anything Semla sets:
 * `~/.config/mcp/mcp.json` and `~/.agents/mcp.json`. Left alone, a session's
 * agent would gain whatever capability was written into either of those for
 * some other tool, with nothing in this repository saying so.
 *
 * `PI_MCP_CONFIG_MODE=exclusive` collapses the adapter's own six-source
 * precedence chain down to one: `getConfigSources` in the package returns a
 * single "Pi exclusive config" entry, host-config auto-discovery (importing
 * from Cursor, Claude, etc.) is switched off, and the package/plugin config
 * loaders it otherwise also merges in are skipped — confirmed by reading and
 * exercising the source directly (jiti, since it is TypeScript under
 * node_modules — plain `import()` cannot strip its types), not assumed from
 * the package's docs. See mcp-config.test.ts for the parts of that behaviour
 * this module depends on.
 *
 * That single remaining file is `getAgentPath("mcp.json")` inside whatever
 * `PI_CODING_AGENT_DIR` points at — the exact env var isolatePiAgentDir()
 * already sets to Semla's own agent directory. So pinning the *mode* is
 * enough; no `--mcp-config` argv flag is needed. That is deliberate: Semla is
 * one long-lived Node process serving concurrent sessions, and `process.argv`
 * is shared across all of them — a flag pushed there for one turn would still
 * be present for every other request the process ever handles. An env var read
 * fresh on each call (`isExclusiveConfigMode()` in the package checks
 * `process.env.PI_MCP_CONFIG_MODE` at call time, not at import time) has no
 * such leak, and setting it once at boot is exactly as durable as
 * `PI_CODING_AGENT_DIR` already is.
 *
 * An operator who wants the shared, cross-tool file back can set
 * `PI_MCP_CONFIG_MODE` themselves before Semla starts — the env var wins over
 * the default here, same as PI_AGENT_DIR does over PI_AGENT_DIR_ENV.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PI_AGENT_DIR } from "@/lib/pi/agent-dir";
import { MCP_PACKAGE_DIR } from "@/lib/pi/runtime-config";

/** Environment variable pi-mcp-adapter reads to select its config mode. */
export const MCP_CONFIG_MODE_ENV = "PI_MCP_CONFIG_MODE";

/** The only mode value the package treats as "one file, no merging". */
export const MCP_EXCLUSIVE_CONFIG_MODE = "exclusive";

/**
 * Where the one file the adapter reads in exclusive mode lives, given
 * Semla's own agent directory. Mirrors the package's own
 * `getAgentPath("mcp.json")`, computed independently so this repository does
 * not have to import a package it loads by path — see runtime-config.ts's
 * WIKI_PACKAGE_DIR docblock for why a deep import here would be a live
 * contract with nothing checking it stays true. mcp-config.test.ts asserts
 * the two computations agree.
 */
export const MCP_CONFIG_PATH = join(PI_AGENT_DIR, "mcp.json");

export interface McpConfigIsolation {
  mode: string;
  path: string;
}

/**
 * Set PI_MCP_CONFIG_MODE, defaulting to exclusive but leaving an operator's
 * own setting alone.
 *
 * Must run before anything binds the mcp extension — the env var is read at
 * call time inside the package, so as long as this runs before a session
 * starts it is in time; instrumentation.ts is where PI_CODING_AGENT_DIR gets
 * the same treatment, for the same reason.
 */
export function isolateMcpConfigMode(
  options: { mode?: string } = {},
): McpConfigIsolation {
  const mode = options.mode ?? process.env[MCP_CONFIG_MODE_ENV] ?? MCP_EXCLUSIVE_CONFIG_MODE;
  process.env[MCP_CONFIG_MODE_ENV] = mode;
  return { mode, path: MCP_CONFIG_PATH };
}

// ── Static server summary ───────────────────────────────────────────────────

/**
 * `dist/config.js` inside the package, deep-imported for one function:
 * `loadMcpConfig`, a pure read of the config file(s) with no network I/O and
 * no server connection attempted. Unlike the extension entry point
 * (MCP_EXTENSION_PATH), this is the *compiled* output, not the TypeScript
 * source — a plain `import()` can load it with no jiti involved, because
 * Node only refuses to strip types, not to run already-compiled JS. That
 * matters here specifically: this call happens from the health endpoint on
 * every request, not once at extension load, so it should not carry jiti's
 * compile cost.
 *
 * A deep import into a third-party package's internals is exactly the kind of
 * thing runtime-config.ts's WIKI_PACKAGE_DIR docblock warns needs a
 * compensating check — a release that renames or moves this file breaks the
 * summary silently otherwise. mcp-config-summary-contract.test.ts is that
 * check, in the mould of wiki-ingest-bridge's WIKI_PACKAGE_DEEP_IMPORTS.
 */
const MCP_CONFIG_MODULE_PATH = join(MCP_PACKAGE_DIR, "dist/config.js");

export const MCP_CONFIG_DEEP_IMPORT = {
  path: MCP_CONFIG_MODULE_PATH,
  exports: ["loadMcpConfig"],
} as const;

interface McpServerEntrySummary {
  disabled?: boolean;
}

interface LoadedMcpConfigModule {
  loadMcpConfig: (
    overridePath?: string,
    cwd?: string,
  ) => { mcpServers: Record<string, McpServerEntrySummary> };
}

export interface McpConfigSummary {
  /** Where the pinned exclusive-mode file lives, whether or not it exists. */
  configPath: string;
  /** Names of every server the file declares, enabled or not. */
  servers: string[];
  /** Subset of `servers` not marked `disabled: true`. */
  enabledServers: string[];
  /** Set when the config could not be read at all — a malformed file, say. */
  error: string | null;
  /**
   * Set when the file parses but declares zero servers *and* looks like a
   * plausible mistake rather than a deliberately empty config — most often,
   * server entries written at the top level instead of nested under an
   * `mcpServers` key. The package's own `loadMcpConfig` treats any shape it
   * does not recognise as "no servers" with no error, so a file like
   * `{ "my-server": { "command": "npx", ... } }` reports the same empty,
   * healthy-looking result as `{}` — hit for real by an operator who wrote a
   * server entry at the top level and saw the settings page report "None
   * configured" with nothing pointing at why.
   */
  hint: string | null;
}

/**
 * A static read of the pinned config: how many servers it declares, with no
 * connection attempted. Connection status (connected / needs-auth / failed) is
 * only known inside a running session — the package publishes it as an event
 * on its own ExtensionAPI instance, not anywhere a route handler can reach —
 * so this answers a narrower, cheaper question: is the gateway pointed at
 * anything at all. A `mcp` tool registered with zero servers configured is
 * the failure this exists to surface, the same class extension-health already
 * covers for a tool that failed to register at all.
 */
export async function getMcpConfigSummary(): Promise<McpConfigSummary> {
  const { path: configPath } = isolateMcpConfigMode();

  // `loadMcpConfig` never throws on bad JSON: readValidatedConfig inside the
  // package catches the parse error itself, `console.warn`s, and returns an
  // empty config — indistinguishable, from out here, from a deliberately
  // empty file. So the file is parsed here too, once, purely for diagnostics:
  // an actual parse failure becomes `error`; a parse that succeeds but whose
  // top level looks like misplaced server entries becomes `hint`. The server
  // list itself still comes from the package's own loader below, which is the
  // one that applies its merge/import/settings rules — this repeats none of
  // that, it only explains a result the package already produced.
  const diagnosis = diagnoseConfigFile(configPath);
  if (diagnosis.error) {
    return { configPath, enabledServers: [], error: diagnosis.error, hint: null, servers: [] };
  }

  try {
    const mod = (await import(
      /* turbopackIgnore: true */ MCP_CONFIG_MODULE_PATH
    )) as LoadedMcpConfigModule;
    const config = mod.loadMcpConfig(undefined, process.cwd());
    const servers = Object.keys(config.mcpServers);
    const enabledServers = servers.filter(
      (name) => config.mcpServers[name]?.disabled !== true,
    );
    const hint = servers.length === 0 ? diagnosis.hint : null;
    return { configPath, enabledServers, error: null, hint, servers };
  } catch (error) {
    return {
      configPath,
      enabledServers: [],
      error: error instanceof Error ? error.message : String(error),
      hint: null,
      servers: [],
    };
  }
}

interface ConfigFileDiagnosis {
  /** Set when the file exists but is not valid JSON. */
  error: string | null;
  /**
   * Set when the file parses but its top level looks like server entries
   * written outside an `mcpServers` key — the mistake this diagnosis exists
   * to catch. Only consulted by the caller when the package's own loader
   * reports zero servers; a file that both parses and declares real servers
   * under `mcpServers` is never flagged, even if it also has stray top-level
   * junk.
   */
  hint: string | null;
}

/**
 * Reads and parses the pinned file once, independently of the package's own
 * loader, purely to explain a zero-server result: was the file missing
 * (fine, not flagged), unparseable (`error`), or parseable but with server
 * entries written at the top level instead of nested under `mcpServers`
 * (`hint`) — e.g. `{ "my-server": { "command": "npx", ... } }`. Deliberately
 * narrow: only flags a top-level value that itself looks like a server entry
 * (a `command`, `url`, or `socket` field), so an intentionally empty `{}` is
 * left alone.
 */
function diagnoseConfigFile(configPath: string): ConfigFileDiagnosis {
  if (!existsSync(configPath)) return { error: null, hint: null };

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    return {
      error: `${configPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      hint: null,
    };
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: null, hint: null };
  }
  const topLevel = raw as Record<string, unknown>;
  if ("mcpServers" in topLevel || "mcp-servers" in topLevel) {
    return { error: null, hint: null };
  }

  const looksLikeServerEntry = (value: unknown): boolean =>
    typeof value === "object" &&
    value !== null &&
    ("command" in value || "url" in value || "socket" in value);

  const misplaced = Object.keys(topLevel).filter((key) =>
    looksLikeServerEntry(topLevel[key]),
  );
  if (misplaced.length === 0) return { error: null, hint: null };

  return {
    error: null,
    hint:
      `${configPath} declares ${misplaced.join(", ")} at the top level, but ` +
      'pi-mcp-adapter only reads servers nested under an "mcpServers" key. ' +
      `Wrap ${misplaced.length === 1 ? "it" : "them"} in { "mcpServers": { ... } }.`,
  };
}
