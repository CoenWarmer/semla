/**
 * The live text of a turn, kept as the sequence of assistant round trips it
 * actually is rather than one flattened string.
 *
 * A turn is not one model reply — the model can say some text, call a tool,
 * say more text, call another tool, and so on. Server-side each of those
 * round trips is its own `message_start`/`message_end` pair and becomes its
 * own persisted message once the turn ends; `groupConversation` (see
 * session-steps.ts) already interleaves a persisted turn's text and tool
 * calls correctly, in the order they happened.
 *
 * Before `round-start` existed, the client had no way to tell which round
 * trip a delta or a tool call belonged to: every delta from every round
 * trip in the turn was concatenated into one `streamingText` string, and
 * every live tool call was tagged with one placeholder id. A turn that said
 * something, called a tool, then said more, rendered live as one flattened
 * blob of text with every tool chip stuck at the bottom — correct once the
 * turn ended and persisted rows replaced it, but visibly wrong while still
 * streaming.
 *
 * These rounds are turned into one pseudo `SessionMessage` per round trip
 * (see liveRoundMessages below, used from client-session-component.tsx) and
 * fed through the *same* `groupConversation` the persisted transcript uses,
 * rather than a second, bespoke live renderer — so live rendering can never
 * drift from what the persisted refetch draws moments later.
 */
import type { SessionMessage } from "@/hooks/use-session-messages";
import { liveRoundMessageId } from "@/lib/live-tool-calls";

export type LiveRound = {
  id: string;
  text: string;
};

/** A new assistant round trip has started. Idempotent against a repeat. */
export function applyRoundStart(
  rounds: readonly LiveRound[],
  event: { roundId: string },
): LiveRound[] {
  if (rounds.some((round) => round.id === event.roundId)) return [...rounds];
  return [...rounds, { id: event.roundId, text: "" }];
}

/**
 * Append a text delta to the round it belongs to. Falls back to creating the
 * round if a delta somehow arrives before its `round-start` — defensive, not
 * expected in practice, since the server always emits round-start from the
 * same `message_start` that opens the round the delta comes from.
 */
export function applyRoundDelta(
  rounds: readonly LiveRound[],
  event: { delta: string; roundId: string },
): LiveRound[] {
  const index = rounds.findIndex((round) => round.id === event.roundId);
  if (index === -1) {
    return [...rounds, { id: event.roundId, text: event.delta }];
  }

  const next = [...rounds];
  next[index] = { ...next[index], text: next[index].text + event.delta };
  return next;
}

/**
 * One pseudo assistant message per live round, in round order, for
 * `groupConversation` to interleave alongside the persisted messages. A
 * round with no text yet (only tool calls so far) becomes a message
 * `isSilent` correctly treats as one to fold into a steps group — same rule
 * a persisted, tool-only turn already gets.
 */
export function liveRoundMessages(
  rounds: readonly LiveRound[],
): SessionMessage[] {
  return rounds.map((round) => ({
    createdAt: new Date().toISOString(),
    id: liveRoundMessageId(round.id),
    role: "assistant" as const,
    text: round.text,
  }));
}
