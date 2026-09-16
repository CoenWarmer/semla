/**
 * Rendering signals for the model.
 *
 * Grouped by state rather than by category, because the states are what change
 * what the agent should do: `available` is callable now,
 * `configured-not-verified` needs a check first, and
 * `possible-not-configured` is a gap it could close. A category-ordered list
 * makes the reader re-derive that grouping every time.
 *
 * Every line carries its evidence. A signal the model cannot trace back to a
 * script name or a config path is one it has to verify again anyway.
 */

import type { DiscoveryResult, SignalState } from "./types";

const STATE_HEADINGS: Record<SignalState, string> = {
  available: "Available (confirmed present, can be run)",
  "configured-not-verified": "Configured, not verified (declared; liveness not probed)",
  "possible-not-configured": "Possible, not configured (dependency present, nothing wires it up)",
  "suggested-by-skill": "Suggested by a skill (a model's reading of skill prose, not a stated fact)",
};

// suggested-by-skill last: it is the one state built on a model's judgement
// rather than something read directly off a file, so it belongs after every
// signal a reader can trust without a second opinion.
const STATE_ORDER: SignalState[] = [
  "available",
  "configured-not-verified",
  "possible-not-configured",
  "suggested-by-skill",
];

export interface RenderOptions {
  root: string;
  /** Set when a status file was written, so the report says where it went. */
  statusPath?: string;
}

export function renderDiscoveryResult(
  result: DiscoveryResult,
  options: RenderOptions,
): string {
  const lines: string[] = [`Verification signals for ${options.root}`, ""];

  if (result.signals.length === 0) {
    lines.push(
      "No verification signals found. Nothing in this project declares a test, lint,",
      "typecheck or dev-server script, and no MCP server is configured.",
    );
  }

  for (const state of STATE_ORDER) {
    const matching = result.signals.filter((signal) => signal.state === state);
    if (matching.length === 0) continue;
    lines.push(`${STATE_HEADINGS[state]}:`);
    for (const signal of matching) {
      const detail = signal.detail === undefined ? "" : ` [${signal.detail}]`;
      lines.push(`  - ${signal.category}${detail} — ${signal.evidence}`);
    }
    lines.push("");
  }

  if (result.warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of result.warnings) lines.push(`  - ${warning}`);
    lines.push("");
  }

  lines.push(
    `Inputs digest: ${result.inputsDigest} (over ${result.inputs.length} file(s))`,
  );
  if (options.statusPath !== undefined) {
    lines.push(`Recorded at: ${options.statusPath}`);
  }
  lines.push(
    "",
    "Discovery is static: nothing here was executed, no port was probed and no MCP",
    "server was connected to. Run a signal yourself before relying on it passing.",
  );

  return lines.join("\n");
}
