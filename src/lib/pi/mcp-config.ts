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

import { join } from "node:path";

import { PI_AGENT_DIR } from "@/lib/pi/agent-dir";

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
