import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import type { SessionToolCall, SessionTranscriptEntry } from "./transcript";

/**
 * What the context window is made of, and how much of it is gone.
 *
 * Deliberately separate from the context *inspection*, which asks a model to
 * judge drift, staleness and corrections. This is arithmetic over lengths: it
 * costs nothing, needs no model call, and can therefore be shown from the
 * first moment of a session rather than waiting for somebody to press Inspect.
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

/** Rough characters per token. Only used before a real count is available. */
const CHARS_PER_TOKEN = 4;

export function computeComposition(
  messages: SessionTranscriptEntry[],
  toolCalls: SessionToolCall[],
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
  messages: SessionTranscriptEntry[],
): number | null {
  return (
    [...messages]
      .reverse()
      .find((m) => m.role === "assistant" && m.inputTokens != null)
      ?.inputTokens ?? null
  );
}

/** Context window of the model a session is configured to use. */
export async function modelContextWindow(
  provider: string | null | undefined,
  modelId: string | null | undefined,
): Promise<number | null> {
  if (!provider || !modelId) return null;
  try {
    // No refresh and no request: this only reads the catalog already on disk.
    const runtime = await ModelRuntime.create({ refreshOnCreate: false });
    return runtime.getModel(provider, modelId)?.contextWindow ?? null;
  } catch {
    return null;
  }
}
