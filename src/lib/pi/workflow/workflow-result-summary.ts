/**
 * Summarise a finished background run for delivery back into the conversation.
 *
 * Mirrors formatResultSection() in the workflow extension's result-text.ts —
 * kept in sync manually, since Semla code does not import extension internals
 * (see the note in workflow-run-reader.ts). The wording differs because this
 * text is a delivered message rather than a tool result, but the failure it
 * guards against is the same one: a script whose body ends in a bare expression
 * instead of `return` produces no result at all, and log() output never reaches
 * the model on its own. Dumping that naively delivered the literal string
 * "null" for a run that had done real work.
 */

const RESULT_SUMMARY_MAX_CHARS = 2000;

/** Runner bookkeeping appended to a run's logs — not script output. */
const LOG_PERSISTED_PREFIX = "Logs persisted to ";

const RETURNLESS_SCRIPT_NOTICE =
  "The script returned no value (it must end with an explicit `return`; a trailing bare expression is discarded). Logged output follows, if any — use it rather than re-running the workflow.";

const capChars = (text: string, max: number): string =>
  text.length <= max
    ? text
    : `${text.slice(0, max)}\n…(truncated — read the rest from the path below)`;

/**
 * Prefer a human-readable field, else a capped JSON dump; fall back to the
 * script's logged output when it returned nothing. The full result and the
 * complete log stay on disk.
 */
export const summarizeRunResult = (
  result: unknown,
  logs: readonly string[] = [],
): string => {
  if (result === undefined) {
    const scriptLogs = logs.filter(
      (entry) => entry.trim() && !entry.startsWith(LOG_PERSISTED_PREFIX),
    );
    return scriptLogs.length > 0
      ? `${RETURNLESS_SCRIPT_NOTICE}\n\n${capChars(scriptLogs.join("\n\n"), RESULT_SUMMARY_MAX_CHARS)}`
      : RETURNLESS_SCRIPT_NOTICE;
  }

  if (typeof result === "string") return result;

  if (result && typeof result === "object") {
    for (const key of ["verdict", "report", "summary", "synthesis"]) {
      const value = (result as Record<string, unknown>)[key];
      if (typeof value === "string" && value.trim()) return value;
    }
  }

  return capChars(
    JSON.stringify(result ?? null, null, 2),
    RESULT_SUMMARY_MAX_CHARS,
  );
};
