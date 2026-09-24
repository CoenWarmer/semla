
/**
 * What the context window is made of, and how much of it is gone.
 *
 * Deliberately separate from the context *inspection*, which asks a model to
 * judge drift, staleness and corrections. This is arithmetic over lengths: it
 * costs nothing, needs no model call, and can therefore be shown from the
 * first moment of a session rather than waiting for somebody to press Inspect.
 *
 * Client-safe, and outside lib/pi for that reason. Costing nothing is only
 * useful if it can run where the numbers already are: the browser holds the
 * transcript it needs, so asking a server to re-read the same transcript and do
 * this arithmetic again was a request that never had to exist. Only
 * `modelContextWindow` stays server-side, in lib/pi/context-composition.ts,
 * because it reaches into the pi runtime's model catalog.
 *
 * The inputs are described structurally rather than imported from the
 * transcript module, so this needs no reference to lib/pi at all — the server's
 * SessionTranscriptEntry and the client's SessionMessage both satisfy them.
 */

export interface CompositionBreakdown {
  systemPromptFraction: number;
  userFraction: number;
  assistantFraction: number;
  toolResultFraction: number;
  /** Fraction of the model's context window in use. Null if unknown. */
  contextWindowFraction: number | null;
  /**
   * True when contextWindowFraction is inferred from character counts rather
   * than measured from a real token count.
   */
  contextWindowEstimated: boolean;
  /** Median cost of this session's recent prompts, in USD. Null before any prompt has reported one. */
  costPerPrompt: number | null;
  summary: string;
}

export const EMPTY_COMPOSITION: CompositionBreakdown = {
  systemPromptFraction: 0,
  userFraction: 0,
  assistantFraction: 0,
  toolResultFraction: 0,
  contextWindowFraction: null,
  contextWindowEstimated: false,
  costPerPrompt: null,
  summary: "No messages yet.",
};

/** The parts of a message this arithmetic reads. */
export type CompositionMessage = {
  role: "assistant" | "user";
  text: string;
  inputTokens?: number;
  tokenUsage?: { cost: number };
};

/** The part of a tool call this arithmetic reads. */
export type CompositionToolCall = {
  resultText?: string;
};

/** Rough characters per token. Only used before a real count is available. */
const CHARS_PER_TOKEN = 4;

export function computeComposition(
  messages: readonly CompositionMessage[],
  toolCalls: readonly CompositionToolCall[],
  systemPromptChars: number,
) {
  const userChars = messages
    .filter((m) => m.role === "user")
    .reduce((sum, m) => sum + m.text.length, 0);
  const assistantChars = messages
    .filter((m) => m.role === "assistant")
    .reduce((sum, m) => sum + m.text.length, 0);
  const toolResultChars = toolCalls.reduce(
    (sum, t) => sum + (t.resultText?.length ?? 0),
    0,
  );

  const totalChars =
    systemPromptChars + userChars + assistantChars + toolResultChars;
  const total = totalChars || 1;

  const systemPromptFraction = systemPromptChars / total;
  const userFraction = userChars / total;
  const assistantFraction = assistantChars / total;
  const toolResultFraction = toolResultChars / total;

  const summary = [
    systemPromptChars > 0
      ? `System ${Math.round(systemPromptFraction * 100)}%`
      : null,
    `User ${Math.round(userFraction * 100)}%`,
    `Assistant ${Math.round(assistantFraction * 100)}%`,
    `Tool results ${Math.round(toolResultFraction * 100)}%`,
  ]
    .filter(Boolean)
    .join(" · ");

  return {
    assistantFraction,
    summary,
    systemPromptFraction,
    toolResultFraction,
    totalChars,
    userFraction,
  };
}

/**
 * How much of the window is in use.
 *
 * Prefers the input-token count the model reported on the last assistant turn,
 * which is exact. Before the first reply there is no such count, and treating
 * "unknown" as "full" would draw a brand-new session as a context window at
 * capacity — so it falls back to estimating from characters, and says it did.
 */
export function contextWindowUsage(
  latestInputTokens: number | null,
  totalChars: number,
  contextWindow: number | null | undefined,
): Pick<
  CompositionBreakdown,
  "contextWindowFraction" | "contextWindowEstimated"
> {
  if (!contextWindow) {
    return { contextWindowFraction: null, contextWindowEstimated: false };
  }
  if (latestInputTokens != null) {
    return {
      contextWindowFraction: Math.min(1, latestInputTokens / contextWindow),
      contextWindowEstimated: false,
    };
  }
  return {
    contextWindowFraction: Math.min(
      1,
      totalChars / CHARS_PER_TOKEN / contextWindow,
    ),
    contextWindowEstimated: true,
  };
}

/** The most recent input-token count the model reported, if any. */
export function latestInputTokens(
  messages: readonly CompositionMessage[],
): number | null {
  return (
    [...messages]
      .reverse()
      .find((m) => m.role === "assistant" && m.inputTokens != null)
      ?.inputTokens ?? null
  );
}

/** How many of the most recent prompts `recentPromptCost` takes the median of. */
const RECENT_PROMPTS = 5;

/**
 * What a prompt in this session has actually cost lately: the median of the
 * last few prompts' summed per-call cost, as the provider billed it.
 *
 * "Prompt", not "turn": in pi a turn is one model call and the tool results
 * that follow it, and a prompt is every turn from one user message to the next
 * — what pi calls an agent run. Per-turn would be the smaller number by the
 * number of tool round trips, so the word matters.
 *
 * Observed rather than modelled. A prompt is as many model calls as the agent
 * makes tool round trips, each re-reading a context that grows as it goes,
 * plus cache writes for everything new, output, and a full re-write whenever
 * the cache has expired. A formula over the current context size left all of
 * that out and came in at a median 1/27th of the real figure.
 *
 * The median, because the last prompt may still be in flight and so only
 * partly counted, and because one long agentic run should not set the figure
 * for every prompt after it. A message steered in mid-run is a user message
 * too, so it starts a new prompt here.
 */
export function recentPromptCost(
  messages: readonly CompositionMessage[],
): number | null {
  const promptCosts: number[] = [];
  let current: number | null = null;
  for (const message of messages) {
    if (message.role === "user") {
      if (current != null) promptCosts.push(current);
      current = null;
    } else if (message.tokenUsage) {
      current = (current ?? 0) + message.tokenUsage.cost;
    }
  }
  if (current != null) promptCosts.push(current);

  const recent = promptCosts.slice(-RECENT_PROMPTS).sort((a, b) => a - b);
  if (recent.length === 0) return null;
  const mid = Math.floor(recent.length / 2);
  return recent.length % 2 === 1
    ? recent[mid]
    : (recent[mid - 1] + recent[mid]) / 2;
}

/**
 * The whole breakdown for one session, from what a transcript response holds.
 *
 * This is the work the composition endpoint used to do. It ran on the server,
 * which meant re-reading and re-parsing the entire session transcript to answer
 * a question about numbers the browser was already holding — and it grew more
 * expensive the longer the conversation got.
 */
export function sessionComposition({
  contextWindow,
  messages,
  systemPromptChars,
  toolCalls,
}: {
  contextWindow: number | null;
  messages: readonly CompositionMessage[];
  systemPromptChars: number;
  toolCalls: readonly CompositionToolCall[];
}): CompositionBreakdown {
  // A session with nothing in it yet still has a system prompt, and that is
  // worth drawing: it is the floor every conversation starts from.
  if (messages.length === 0 && systemPromptChars === 0) return EMPTY_COMPOSITION;

  const metrics = computeComposition(messages, toolCalls, systemPromptChars);
  const inputTokens = latestInputTokens(messages);

  return {
    assistantFraction: metrics.assistantFraction,
    summary: metrics.summary,
    systemPromptFraction: metrics.systemPromptFraction,
    toolResultFraction: metrics.toolResultFraction,
    userFraction: metrics.userFraction,
    costPerPrompt: recentPromptCost(messages),
    ...contextWindowUsage(inputTokens, metrics.totalChars, contextWindow),
  };
}
