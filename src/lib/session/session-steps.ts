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
 *
 * Two tools are exempt from the fold. An `ask_user` call is not the agent's
 * own work — it is a question the reader answered, and the answers are part
 * of the conversation in the way a message is. `capture_feature_spec` is the
 * same shape: a form the reader filled in, not agent work. Burying either
 * behind an unlabelled dot loses the record of what was actually agreed, so
 * both are lifted out of the run as their own items and rendered beside the
 * messages. See ask-user-record.ts and feature-spec-record.ts.
 */

import type { SessionMessage, SessionToolCall } from "@/hooks/use-session-messages";
import { parseAskUserResult, type AskUserPair } from "@/lib/tool-records/ask-user-record";
import {
  parseFeatureSpecResult,
  type FeatureSpecField,
} from "@/lib/tool-records/feature-spec-record";
import type { StepTurnUsage } from "@/lib/session/step-usage";

/**
 * `usage` is the *turn's* usage, not the step's — see step-usage.ts for why
 * there is no per-call figure to have. Absent where the turn reported none,
 * which is every step of a live turn that has not closed yet.
 */
export type StepItem =
  | {
      kind: "thinking";
      id: string;
      messageId: string;
      text: string;
      usage?: StepTurnUsage;
    }
  | {
      kind: "tool";
      id: string;
      messageId: string;
      call: SessionToolCall;
      usage?: StepTurnUsage;
    };

export type ConversationItem =
  | { kind: "message"; message: SessionMessage }
  | { kind: "steps"; id: string; items: StepItem[] }
  | {
      kind: "ask";
      id: string;
      /** Empty while the call is still open — nothing answered yet. */
      pairs: AskUserPair[];
      /** True once the tool returned an error, i.e. it was cancelled. */
      cancelled: boolean;
      /** Result text that did not parse into pairs, shown verbatim. */
      raw?: string;
    }
  | {
      kind: "feature-spec";
      id: string;
      /** Empty while the form is still open — nothing submitted yet. */
      fields: FeatureSpecField[];
      /** True once the tool returned an error, i.e. it was cancelled. */
      cancelled: boolean;
      /** Result text that did not parse into fields, shown verbatim. */
      raw?: string;
    };

/** The tool whose result is a record of the reader's answers, not agent work. */
const ASK_USER_TOOL = "ask_user";
/** The tool whose result is the reader's submitted feature spec, not agent work. */
const FEATURE_SPEC_TOOL = "capture_feature_spec";

/**
 * A call is still open when no result has arrived. Mid-turn that is the whole
 * window between the question appearing and the reader answering it, and there
 * is nothing to record yet — the questions themselves are already on screen in
 * the answer dialog, so a card here would ask them a second time, directly
 * above it, with an empty answer under each. `resultAt` is what the live
 * `tool-end` event sets (see applyLiveToolEvent), and what the persisted row
 * carries once the turn is written, so one check covers both paths.
 */
const isPending = (call: SessionToolCall): boolean =>
  call.resultAt === undefined && call.resultText === undefined && !call.isError;

const askItem = (call: SessionToolCall): ConversationItem => {
  const pairs = call.isError ? [] : parseAskUserResult(call.resultText);
  const raw = call.errorText ?? call.resultText;

  return {
    cancelled: call.isError === true,
    id: `ask:${call.messageId}:${call.id}`,
    kind: "ask",
    pairs,
    ...(pairs.length === 0 && raw?.trim() ? { raw } : {}),
  };
};

const featureSpecItem = (call: SessionToolCall): ConversationItem => {
  const fields = call.isError ? [] : parseFeatureSpecResult(call.resultText);
  const raw = call.errorText ?? call.resultText;

  return {
    cancelled: call.isError === true,
    fields,
    id: `feature-spec:${call.messageId}:${call.id}`,
    kind: "feature-spec",
    ...(fields.length === 0 && raw?.trim() ? { raw } : {}),
  };
};

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
    const calls = callsByMessage.get(message.id) ?? [];

    // An ask (or a feature-spec form) is lifted out whether or not its turn
    // said anything. A turn that introduces the question ('a few things
    // determine the design:') does have text, so it never reaches the
    // silent-fold path below — which is how the first version of this
    // rendered nothing for exactly the calls that matter most, the ones the
    // agent bothered to preface.
    const asks = calls
      .filter((call) => call.name === ASK_USER_TOOL && !isPending(call))
      .map(askItem);
    const featureSpecs = calls
      .filter((call) => call.name === FEATURE_SPEC_TOOL && !isPending(call))
      .map(featureSpecItem);

    if (!isSilent(message)) {
      items.push({ kind: "message", message });
      items.push(...asks, ...featureSpecs);
      continue;
    }

    const steps: StepItem[] = [];
    // The calls this turn contributes to the strip. Counted before the steps
    // are built because every step of the turn is annotated with it, and it is
    // what tells the reader that two dots share one figure.
    const stepCalls = calls.filter(
      (call) => call.name !== ASK_USER_TOOL && call.name !== FEATURE_SPEC_TOOL,
    );
    const usage: StepTurnUsage | undefined = message.tokenUsage
      ? {
          callsInTurn: stepCalls.length,
          cost: message.tokenUsage.cost,
          tokens: message.tokenUsage.total,
        }
      : undefined;

    // Reasoning first: it is why the calls beneath it happened.
    if (message.thinking?.trim()) {
      steps.push({
        id: `${message.id}:thinking`,
        kind: "thinking",
        messageId: message.id,
        text: message.thinking,
        ...(usage ? { usage } : {}),
      });
    }
    for (const call of stepCalls) {
      steps.push({
        call,
        id: `${message.id}:${call.id}`,
        kind: "tool",
        messageId: message.id,
        ...(usage ? { usage } : {}),
      });
    }

    // A silent turn with no reasoning and no calls has genuinely nothing in it.
    // Drop it rather than drawing a dot that opens onto nothing.
    if (steps.length > 0) {
      const previous = items.at(-1);
      if (previous?.kind === "steps") previous.items.push(...steps);
      else items.push({ id: `steps:${message.id}`, items: steps, kind: "steps" });
    }

    // After the strip: the reasoning and calls that led to the question read as
    // preceding it, and an ask/feature-spec ends the run so the next silent
    // turn starts a new strip rather than reaching back across it.
    items.push(...asks, ...featureSpecs);
  }

  return items;
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
