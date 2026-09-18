/**
 * The agent's own bash calls, as a console log.
 *
 * Two sources, one shape. While a turn runs, pi's bash tool reports its output
 * as it arrives (`tool_execution_update`, throttled server-side) and the router
 * republishes it as a `bash-output` event; after a reload there is no stream
 * left, only the persisted tool-call rows the transcript already fetches. Both
 * fold into `AgentConsoleEntry` here so the panel has one list to draw rather
 * than a live view and a history view that can disagree.
 *
 * The important detail about the live half: each update carries the output
 * *cumulatively*, not as a delta. Appending them would show the same command's
 * output N times over, so an update replaces an entry's output rather than
 * extending it.
 */

import type { SessionToolCall } from "@/hooks/use-session-messages";

/** One agent bash call. */
export type AgentConsoleEntry = {
  command: string;
  /** Absent while the call is still running. */
  endedAt?: string;
  isError?: boolean;
  /** Cumulative stdout+stderr, as far as it has been reported. */
  output: string;
  startedAt: string;
  toolCallId: string;
};

/**
 * How many calls the panel keeps.
 *
 * A session can make hundreds of bash calls, and every entry holds its output;
 * the console is somewhere to watch what the agent is doing now, not the
 * transcript — which is what the conversation view is for.
 */
export const MAX_CONSOLE_ENTRIES = 60;

/**
 * How much output one call keeps, in characters.
 *
 * The tail rather than the head: a build or a test run says what went wrong at
 * the end. pi truncates long output before it ever reaches us, so this is a
 * second bound on the client's memory rather than the only one.
 */
export const MAX_ENTRY_OUTPUT_CHARS = 40_000;

export type AgentConsoleEvent =
  | {
      at: string;
      command: string;
      toolCallId: string;
      type: "bash-start";
    }
  | {
      output: string;
      toolCallId: string;
      type: "bash-output";
    }
  | {
      at: string;
      isError: boolean;
      /** The final result text, when the stream never reported any output. */
      output?: string;
      toolCallId: string;
      type: "bash-end";
    };

const clampOutput = (output: string): string =>
  output.length > MAX_ENTRY_OUTPUT_CHARS
    ? output.slice(-MAX_ENTRY_OUTPUT_CHARS)
    : output;

const capEntries = (entries: AgentConsoleEntry[]): AgentConsoleEntry[] =>
  entries.length > MAX_CONSOLE_ENTRIES
    ? entries.slice(entries.length - MAX_CONSOLE_ENTRIES)
    : entries;

/**
 * Fold one event into the log.
 *
 * Returns the same contents on an event that changes nothing — an output or end
 * event for a call that was never started, which is what a client attaching
 * mid-turn sees. A start for a call already present is also ignored rather than
 * duplicated, mirroring applyLiveToolEvent.
 */
export function applyAgentConsoleEvent(
  entries: readonly AgentConsoleEntry[],
  event: AgentConsoleEvent,
): AgentConsoleEntry[] {
  if (event.type === "bash-start") {
    if (entries.some((entry) => entry.toolCallId === event.toolCallId)) {
      return [...entries];
    }

    return capEntries([
      ...entries,
      {
        command: event.command,
        output: "",
        startedAt: event.at,
        toolCallId: event.toolCallId,
      },
    ]);
  }

  const index = entries.findIndex(
    (entry) => entry.toolCallId === event.toolCallId,
  );
  if (index === -1) return [...entries];

  const next = [...entries];
  const current = next[index];

  if (event.type === "bash-output") {
    // Replacement, not concatenation: see the module comment.
    next[index] = { ...current, output: clampOutput(event.output) };
    return next;
  }

  next[index] = {
    ...current,
    endedAt: event.at,
    isError: event.isError,
    // The end event's text is a fallback for a call that finished before any
    // update arrived — a fast command often produces exactly one snapshot, and
    // an aborted one produces none. An entry that already streamed output keeps
    // it, because the streamed copy is at least as complete as the result text
    // the transcript trims.
    ...(current.output ? {} : { output: clampOutput(event.output ?? "") }),
  };
  return next;
}

/**
 * The bash calls a persisted transcript contains.
 *
 * `params.command` is the argument the router captured on the call, and
 * `resultText` is the trimmed output the transcript keeps — the same two fields
 * the live path reports, so a reload lands on the same list minus the
 * intermediate frames.
 */
export function agentConsoleFromToolCalls(
  toolCalls: readonly SessionToolCall[],
): AgentConsoleEntry[] {
  const entries = toolCalls.flatMap((call): AgentConsoleEntry[] => {
    if (call.name !== "bash") return [];
    const command = call.params?.["command"];
    if (!command) return [];

    return [
      {
        command,
        ...(call.resultAt ? { endedAt: call.resultAt } : {}),
        ...(call.isError === undefined ? {} : { isError: call.isError }),
        output: clampOutput(call.errorText ?? call.resultText ?? ""),
        startedAt: call.createdAt,
        toolCallId: call.id,
      },
    ];
  });

  return capEntries(
    entries.sort((left, right) => left.startedAt.localeCompare(right.startedAt)),
  );
}

/**
 * Combine the persisted log with the live one.
 *
 * Live wins for a call in both, the opposite of `mergeToolCalls`: there the
 * persisted row carries strictly more (a real messageId to scroll to), while
 * here the streamed output is the richer copy — it is capped at
 * `MAX_ENTRY_OUTPUT_CHARS` rather than the 4000 characters the transcript keeps
 * per tool result. Sorted by start time so a refetch cannot reorder the list.
 */
export function mergeAgentConsole(
  persisted: readonly AgentConsoleEntry[],
  live: readonly AgentConsoleEntry[],
): AgentConsoleEntry[] {
  const liveIds = new Set(live.map((entry) => entry.toolCallId));

  return capEntries(
    [...persisted.filter((entry) => !liveIds.has(entry.toolCallId)), ...live].sort(
      (left, right) => left.startedAt.localeCompare(right.startedAt),
    ),
  );
}

/**
 * Strip ANSI control sequences.
 *
 * The agent's bash runs on a pipe rather than a tty, so most commands emit none
 * — but a tool that forces colour (`--color=always`, or anything honouring
 * `FORCE_COLOR`) does, and this pane is plain text rather than an emulator.
 * Unlike the interactive shell in the other tab there is no cursor to move: the
 * output is a transcript, so dropping the sequences is the whole of what is
 * needed.
 */
// oxlint-disable-next-line no-control-regex
const ANSI_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:;\d{0,4})*)?[0-9A-PR-TZcf-nq-uy=><]/g;

export const stripAnsi = (text: string): string => text.replace(ANSI_PATTERN, "");
