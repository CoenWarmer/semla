/**
 * Tool-call rows for the timeline while a prompt is still streaming.
 *
 * The persisted rows the transcript builds only exist after the turn ends —
 * session entries are written to Supabase in one pass at prompt-complete, so
 * `/api/sessions/[id]/messages` cannot report a tool call until then. That left
 * the waterfall's "Tool calls" row empty for the whole run and filled it in
 * afterwards. These build the same rows from the SSE stream instead, keyed by
 * the pi `toolCallId` that the persisted row will also carry — so when the
 * refetch lands, the two are the same row rather than a duplicate.
 */
import type { SessionToolCall } from "@/hooks/use-session-messages";

export type LiveToolEvent =
  | {
      at: string;
      params?: Record<string, string>;
      summary?: string;
      toolCallId: string;
      toolName: string;
      type: "tool-start";
    }
  | {
      at: string;
      isError: boolean;
      toolCallId: string;
      toolName: string;
      type: "tool-end";
    };

/**
 * Fold one streamed tool event into the live list: a start appends a row, an
 * end closes the matching one. Returns the same array when nothing changed, so
 * an unmatched or repeated event cannot trigger a re-render.
 */
export function applyLiveToolEvent(
  calls: readonly SessionToolCall[],
  event: LiveToolEvent,
): SessionToolCall[] {
  if (event.type === "tool-start") {
    if (calls.some((call) => call.id === event.toolCallId)) return [...calls];

    return [
      ...calls,
      {
        createdAt: event.at,
        id: event.toolCallId,
        // No entry exists yet, so there is nothing to scroll the transcript to.
        // Marker clicks guard on this being non-empty.
        messageId: "",
        name: event.toolName,
        ...(event.summary ? { summary: event.summary } : {}),
        ...(event.params ? { params: event.params } : {}),
      },
    ];
  }

  const index = calls.findIndex((call) => call.id === event.toolCallId);
  if (index === -1) return [...calls];

  const next = [...calls];
  next[index] = {
    ...next[index],
    isError: event.isError,
    resultAt: event.at,
  };
  return next;
}

/**
 * Combine persisted and live rows, preferring the persisted one for any call
 * present in both — it carries the result text and the messageId a marker
 * needs to scroll the transcript. Sorted by start time so the order does not
 * jump as the refetch replaces live rows.
 */
export function mergeToolCalls(
  persisted: readonly SessionToolCall[],
  live: readonly SessionToolCall[],
): SessionToolCall[] {
  const persistedIds = new Set(persisted.map((call) => call.id));

  return [...persisted, ...live.filter((call) => !persistedIds.has(call.id))].sort(
    (left, right) => left.createdAt.localeCompare(right.createdAt),
  );
}
