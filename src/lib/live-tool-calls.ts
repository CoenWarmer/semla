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
 * Prefix shared with the placeholder pseudo-messages built in
 * live-rounds.ts's liveRoundMessages(), so a `messageId` on a live-round
 * pseudo-message and on the tool calls that round produced can be told apart
 * from a real persisted message id (which is a UUID and never starts with
 * this). `LIVE_ROUND_PREFIX + roundId` from a `round-start` SSE event (see
 * session-events.ts) is the actual messageId used — one per assistant round
 * trip, not one constant for the whole turn, so groupConversation can
 * interleave live text and live tool calls the same way it already
 * interleaves the persisted rows a round trip becomes once the turn ends.
 */
export const LIVE_ROUND_PREFIX = "live-round-message:";

export const liveRoundMessageId = (roundId: string): string =>
  `${LIVE_ROUND_PREFIX}${roundId}`;

export const isLiveRoundMessageId = (messageId: string): boolean =>
  messageId.startsWith(LIVE_ROUND_PREFIX);

export type LiveToolEvent =
  | {
      at: string;
      params?: Record<string, string>;
      roundId: string;
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
      roundId: string;
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
        // Points at this round's placeholder pseudo-message rather than a real
        // one — there is nothing to scroll the transcript to yet. Marker
        // clicks guard on this being non-empty, and it is.
        messageId: liveRoundMessageId(event.roundId),
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
