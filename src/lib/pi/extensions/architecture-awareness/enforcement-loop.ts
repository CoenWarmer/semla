/**
 * Item 4: run the target repo's boundary/lint checks after each accepted
 * edit, and feed failures back to the agent as a tool result.
 *
 * Deliberately not a fatal error and not a separate tool call the agent
 * decides to make — it runs automatically after every edit/write this
 * extension's tools (`placement-tools.ts`) accept, and its output is folded
 * into that same tool result so the agent sees it in the same turn, the way
 * it would see the edit's own diff.
 *
 * The command is configured per target repo
 * (`ArchitectureAwarenessSettings.enforcementCommand`, read via
 * `loadArchitectureAwarenessSettings(cwd)` so a project-level override in
 * `<cwd>/.semla/architecture-awareness-settings.json` can name a different
 * command per repo). No command configured means skip — this is not a
 * feature that invents a linter to run.
 */

import { execFile } from "node:child_process";

export interface EnforcementResult {
  ran: boolean;
  command?: string;
  exitCode?: number;
  output?: string;
}

const ENFORCEMENT_TIMEOUT_MS = 60_000;
/** Output is folded into a tool result the model reads; cap it like read/grep do. */
const MAX_OUTPUT_CHARS = 8_000;

/**
 * Run the configured command in `cwd` via the shell, capturing combined
 * stdout+stderr. Never throws: a non-zero exit is exactly the "failure" this
 * is meant to report, not an exceptional condition, and a spawn error (e.g.
 * misconfigured command) is folded into the same shape so the caller has one
 * code path.
 */
export function runEnforcementCommand(
  command: string | undefined,
  cwd: string,
): Promise<EnforcementResult> {
  if (!command || !command.trim()) {
    return Promise.resolve({ ran: false });
  }

  return new Promise((resolvePromise) => {
    execFile(
      "/bin/sh",
      ["-c", command],
      { cwd, timeout: ENFORCEMENT_TIMEOUT_MS },
      (error, stdout, stderr) => {
        const combined = `${stdout ?? ""}${stderr ?? ""}`.trim();
        const truncated =
          combined.length > MAX_OUTPUT_CHARS
            ? `${combined.slice(0, MAX_OUTPUT_CHARS)}\n… truncated`
            : combined;

        resolvePromise({
          command,
          exitCode: error && "code" in error ? Number(error.code) || 1 : 0,
          output: truncated,
          ran: true,
        });
      },
    );
  });
}

/** Renders the enforcement result as text appended to a tool result, or "" when nothing ran or it passed silently. */
export function renderEnforcementFeedback(result: EnforcementResult): string {
  if (!result.ran) return "";
  if (result.exitCode === 0) {
    return result.output
      ? `\n\n[enforcement: ${result.command}]\n${result.output}`
      : "";
  }
  return (
    `\n\n[enforcement FAILED: ${result.command} exited ${result.exitCode}]\n` +
    `${result.output || "(no output)"}`
  );
}
