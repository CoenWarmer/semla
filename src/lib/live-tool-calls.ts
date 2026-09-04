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

/**
 * The `messageId` a live tool call carries before the turn's real assistant
 * message exists. `groupConversation` matches calls to messages by id, so
 * without a shared placeholder id here it can never fold a still-streaming
 * call into a steps group — the chip only appeared once the turn ended and
 * the persisted refetch supplied a real id. A caller that wants live calls to
 * render inline must add a placeholder message carrying this same id.
 */
export const LIVE_MESSAGE_ID = "live-turn";

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
      errorText?: string;
      isError: boolean;
      resultText?: string;
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
        // Points at the placeholder live-turn message rather than a real one —
        // there is nothing to scroll the transcript to yet. Marker clicks guard
        // on this being non-empty, and LIVE_MESSAGE_ID is.
        messageId: LIVE_MESSAGE_ID,
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
    ...(event.errorText ? { errorText: event.errorText } : {}),
    ...(event.resultText ? { resultText: event.resultText } : {}),
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
