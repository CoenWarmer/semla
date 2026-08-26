/**
 * Formatting for the part of a completed run's tool result that carries the
 * workflow's output back to the model.
 *
 * Kept free of runtime imports so it can be unit-tested without loading the
 * agent or TUI packages.
 */

/** Cap on the logged output surfaced for a run that returned nothing. */
const RETURNLESS_LOG_MAX_CHARS = 4_000;

/** Runner bookkeeping appended to state.logs — not script output. */
const LOG_PERSISTED_PREFIX = "Logs persisted to ";

/** Text shown in place of a result when the script returned nothing. */
export const RETURNLESS_SCRIPT_NOTICE =
  "_The script returned no value. End it with an explicit `return` — the body runs as an async IIFE, so a trailing bare expression (`summary;`) is evaluated and discarded. Note that `log()` output is never visible to you either._";

/**
 * Build the `## Result` section of a completed run's tool result.
 *
 * A run that spawned agents but returned nothing is nearly always an authoring
 * slip rather than an intentionally empty result, and the two ways a script can
 * hand back data fail in opposite directions: `return` is easy to forget, and
 * `log()` reaches only `details.logs` and the run's `.log` file — both for the
 * UI and the human, never for the model. Rendering that case as a bare `##
 * Result` heading directly above the revise hint cost a real duplicate run
 * (session e77d3124, run cute-animals-mtab1918-esb0dx): the model read the hint
 * as the result, found no data, and re-ran the whole workflow to get lists that
 * were already sitting in the logs. So name the mistake, and fall back to the
 * logs so a returnless run still hands its work back.
 */
export function formatResultSection(
  result: unknown,
  logs: readonly string[] = [],
): string {
  if (result !== undefined) {
    return `## Result\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``;
  }

  const sections = ["## Result", RETURNLESS_SCRIPT_NOTICE];
  const logged = formatLoggedOutput(logs);
  if (logged) {
    sections.push(
      "### Logged output",
      "What the script logged is below. Use it if it answers the task — do not re-run the workflow for data it has already produced.",
      logged,
    );
  }

  return sections.join("\n\n");
}

/**
 * Join a run's script-authored log entries into one capped block, or return
 * undefined when it logged nothing worth surfacing.
 */
export function formatLoggedOutput(
  logs: readonly string[],
  maxChars = RETURNLESS_LOG_MAX_CHARS,
): string | undefined {
  const scriptLogs = logs.filter(
    (entry) => entry.trim() && !entry.startsWith(LOG_PERSISTED_PREFIX),
  );
  if (scriptLogs.length === 0) return undefined;

  const joined = scriptLogs.join("\n\n");
  return joined.length <= maxChars
    ? joined
    : `${joined.slice(0, maxChars)}\n…(truncated ${joined.length - maxChars} chars — the full log is in the run file)`;
}
