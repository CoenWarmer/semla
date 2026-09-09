/**
 * Telling the agent that a code index exists, at the moment it would have
 * helped.
 *
 * Measured before this was written, across 120 recorded sessions: bash is 4,004
 * of the tool calls, and 63% of that is file inspection — `grep` alone runs
 * 1,240 times against 513 uses of the `read` tool. Meanwhile every specialised
 * code tool is ignored. `code_find` was called twice; supi's other five, and
 * `code_map`, essentially never. Adding a system-prompt bullet is what did not
 * work for those seven, so `code_search` needs something better than being
 * described once, fifty turns before it is relevant.
 *
 * **The trigger is the result, not the command.** Deciding from the pattern
 * whether a search was "exploratory" means guessing at intent, and guessing
 * wrongly means nagging someone who did the right thing. The result says it
 * plainly instead:
 *
 *  - **No matches** — the agent guessed an identifier and guessed wrong. That
 *    is precisely the query whose wording does not appear in the code.
 *  - **Too many matches** — the pattern was too broad to answer anything, and
 *    read-router has just truncated it.
 *
 * A grep that returned a workable number of matches gets no nudge, because
 * nothing went wrong. `grep -rl "phase_bar_terminal_fix_2"` finding its three
 * files is the right tool used correctly, and semantic search over vectors
 * scoring 0.24 to 0.40 would be strictly worse at it.
 *
 * Capped per session. A hint that appears on every failed grep is noise, and
 * noise is what the model learns to skip.
 */

/** Nudges per session. Enough to be noticed, few enough not to become wallpaper. */
export const MAX_NUDGES_PER_SESSION = 3;

/** Matches above this are "too many to read", matching read-router's threshold. */
export const TOO_MANY_MATCHES = 40;

/** Commands whose failure or flood this can speak to. */
const SEARCH_COMMAND = /(?:^|\||&&|;|\()\s*(?:grep|rg|ag|ack|fd)\b/;

/**
 * Searches over things that are not this project's source. A grep through
 * session logs or node_modules is not a question the index can answer.
 */
// No leading \b: it is not a word boundary before a literal dot, so the
// dot-prefixed directories would never have matched.
const NOT_PROJECT_SOURCE =
  /(?:\bnode_modules\b|\.semla-sessions|\.semla-debug|\.next\b|\bdist\b|package-lock\.json)/;

export interface NudgeInput {
  command: string;
  /** The tool result text, after any compression upstream. */
  output: string;
  /** False when this project has no index, in which case there is nothing to suggest. */
  indexed: boolean;
  /** How many nudges this session has already emitted. */
  alreadyNudged: number;
}

/** The line to append, or null to stay quiet. */
export function nudgeFor({
  command,
  output,
  indexed,
  alreadyNudged,
}: NudgeInput): string | null {
  if (!indexed) return null;
  if (alreadyNudged >= MAX_NUDGES_PER_SESSION) return null;
  if (!SEARCH_COMMAND.test(command)) return null;
  if (NOT_PROJECT_SOURCE.test(command)) return null;

  const trimmed = output.trim();
  const lines = trimmed.length === 0 ? 0 : trimmed.split("\n").length;

  if (lines === 0) {
    return (
      "\n\n[code index] That search matched nothing. This project has a code index — " +
      "`code_search` finds code by meaning rather than by name, which is what you " +
      "want when the identifier you guessed is not the one used."
    );
  }

  if (lines > TOO_MANY_MATCHES) {
    return (
      "\n\n[code index] That pattern matched too much to read. This project has a code " +
      "index — `code_search` ranks by meaning and returns a handful of cited ranges, " +
      "which narrows this faster than tightening the pattern."
    );
  }

  return null;
}
