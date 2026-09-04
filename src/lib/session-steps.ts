/**
 * Folding the turns that have nothing to say into the steps they actually took.
 *
 * An assistant turn that only calls tools carries no text, so the conversation
 * rendered it as an empty bubble. In one real session that was fifteen empty
 * boxes between a question and its answer.
 *
 * They are not empty, though — every one of them held reasoning and a tool call,
 * and together they carried about thirteen cents of tokens. Dropping them would
 * have hidden work that was really done, and their usage is summed elsewhere for
 * the session cost, so removing them from the list is not an option either.
 *
 * Instead consecutive text-less turns collapse into one group of steps, which
 * the UI can draw as a strip of dots. Grouping the *run* rather than each turn
 * is the point: fifteen chips in a column is barely better than fifteen empty
 * boxes, while one strip is a single line between the question and the answer.
 *
 * Turns that do have text are left exactly as they were.
 */

import type { SessionMessage, SessionToolCall } from "@/hooks/use-session-messages";

export type StepItem =
  | { kind: "thinking"; id: string; messageId: string; text: string }
  | { kind: "tool"; id: string; messageId: string; call: SessionToolCall };

export type ConversationItem =
  | { kind: "message"; message: SessionMessage }
  | { kind: "steps"; id: string; items: StepItem[] };

/** A turn the conversation has nothing to print for. */
const isSilent = (message: SessionMessage): boolean =>
  message.role === "assistant" && message.text.trim().length === 0;

/**
 * Split the transcript into things to print and runs of steps to fold.
 *
 * Tool calls are matched to their turn by `messageId`, which the transcript
 * builder already records for exactly this kind of association. Calls whose turn
 * did produce text are left alone — they show on the timeline as before, and
 * pulling them out would change how turns that were never the problem render.
 */
export function groupConversation(
  messages: readonly SessionMessage[],
  toolCalls: readonly SessionToolCall[] = [],
): ConversationItem[] {
  const callsByMessage = new Map<string, SessionToolCall[]>();
  for (const call of toolCalls) {
    const group = callsByMessage.get(call.messageId);
    if (group) group.push(call);
    else callsByMessage.set(call.messageId, [call]);
  }

  const items: ConversationItem[] = [];

  for (const message of messages) {
    if (!isSilent(message)) {
      items.push({ kind: "message", message });
      continue;
    }

    const steps: StepItem[] = [];
    // Reasoning first: it is why the calls beneath it happened.
    if (message.thinking?.trim()) {
      steps.push({
        id: `${message.id}:thinking`,
        kind: "thinking",
        messageId: message.id,
        text: message.thinking,
      });
    }
    for (const call of callsByMessage.get(message.id) ?? []) {
      steps.push({
        call,
        id: `${message.id}:${call.id}`,
        kind: "tool",
        messageId: message.id,
      });
    }

    // A silent turn with no reasoning and no calls has genuinely nothing in it.
    // Drop it rather than drawing a dot that opens onto nothing.
    if (steps.length === 0) continue;

    const previous = items.at(-1);
    if (previous?.kind === "steps") previous.items.push(...steps);
    else items.push({ id: `steps:${message.id}`, items: steps, kind: "steps" });
  }

  return items;
}

/**
 * Pull the live turn's own steps off the end of a conversation, so the caller
 * can draw them after the streaming answer instead of before it.
 *
 * The live-turn placeholder message (see LIVE_MESSAGE_ID in
 * live-tool-calls.ts) is always appended last, by construction, so its steps
 * — when present — always land inside the trailing item groupConversation
 * produces. But that trailing group is not necessarily *only* the live turn:
 * groupConversation folds consecutive silent turns into one strip, so an
 * already-finished turn immediately before it (one that also had no text —
 * e.g. it ended in a tool error) merges into the same group. Pulling that
 * whole group out would move finished, historical steps below an answer they
 * have nothing to do with. This splits by `messageId` instead of by group, so
 * only the steps whose `messageId` is the live placeholder move; anything else
 * in that trailing group is kept behind in `historyItems`, in its own group,
 * exactly where groupConversation put it.
 */
export function splitLiveSteps(
  items: readonly ConversationItem[],
  liveMessageId: string,
): { historyItems: ConversationItem[]; liveSteps: Extract<ConversationItem, { kind: "steps" }> | null } {
  const last = items.at(-1);
  if (last?.kind !== "steps") {
    return { historyItems: [...items], liveSteps: null };
  }

  const liveItems = last.items.filter((item) => item.messageId === liveMessageId);
  if (liveItems.length === 0) {
    return { historyItems: [...items], liveSteps: null };
  }

  const finishedItems = last.items.filter(
    (item) => item.messageId !== liveMessageId,
  );
  const historyItems =
    finishedItems.length > 0
      ? [...items.slice(0, -1), { ...last, items: finishedItems }]
      : items.slice(0, -1);

  return {
    historyItems,
    liveSteps: { ...last, items: liveItems },
  };
}

/** "12 bash · 3 code_map", for the strip's label. */
export function summariseSteps(items: readonly StepItem[]): string {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.kind !== "tool") continue;
    counts.set(item.call.name, (counts.get(item.call.name) ?? 0) + 1);
  }

  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => (count > 1 ? `${count} ${name}` : name));

  const thinking = items.filter((item) => item.kind === "thinking").length;
  if (thinking > 0) parts.push(thinking > 1 ? `${thinking} thoughts` : "1 thought");

  return parts.join(" · ");
}
