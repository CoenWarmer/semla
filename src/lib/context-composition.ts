
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
  summary: string;
}

export const EMPTY_COMPOSITION: CompositionBreakdown = {
  systemPromptFraction: 0,
  userFraction: 0,
  assistantFraction: 0,
  toolResultFraction: 0,
  contextWindowFraction: null,
  contextWindowEstimated: false,
  summary: "No messages yet.",
};

/** The parts of a message this arithmetic reads. */
export type CompositionMessage = {
  role: "assistant" | "user";
  text: string;
  inputTokens?: number;
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

  return {
    assistantFraction: metrics.assistantFraction,
    summary: metrics.summary,
    systemPromptFraction: metrics.systemPromptFraction,
    toolResultFraction: metrics.toolResultFraction,
    userFraction: metrics.userFraction,
    ...contextWindowUsage(
      latestInputTokens(messages),
      metrics.totalChars,
      contextWindow,
    ),
  };
}
