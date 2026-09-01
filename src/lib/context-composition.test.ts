import { describe, expect, it } from "vitest";

import {
  computeComposition,
  contextWindowUsage,
  EMPTY_COMPOSITION,
  latestInputTokens,
  sessionComposition,
} from "./context-composition";
import type {
  SessionToolCall,
  SessionTranscriptEntry,
} from "@/lib/pi/transcript";

const message = (
  role: "user" | "assistant",
  text: string,
  inputTokens?: number,
): SessionTranscriptEntry =>
  ({ role, text, inputTokens }) as unknown as SessionTranscriptEntry;

const tool = (resultText: string): SessionToolCall =>
  ({ resultText }) as unknown as SessionToolCall;

describe("computeComposition", () => {
  it("splits the window by where the characters came from", () => {
    const result = computeComposition(
      [message("user", "a".repeat(25)), message("assistant", "b".repeat(25))],
      [tool("c".repeat(25))],
      25,
    );
    expect(result.systemPromptFraction).toBeCloseTo(0.25);
    expect(result.userFraction).toBeCloseTo(0.25);
    expect(result.assistantFraction).toBeCloseTo(0.25);
    expect(result.toolResultFraction).toBeCloseTo(0.25);
    expect(result.totalChars).toBe(100);
  });

  it("counts a system prompt on its own, before any messages", () => {
    // A session that has only just opened is exactly this case, and it is the
    // one the bar most needs to draw.
    const result = computeComposition([], [], 4_000);
    expect(result.systemPromptFraction).toBe(1);
    expect(result.totalChars).toBe(4_000);
  });

  it("does not divide by zero on an empty session", () => {
    const result = computeComposition([], [], 0);
    expect(result.totalChars).toBe(0);
    expect(result.userFraction).toBe(0);
  });

  it("omits the system prompt from the summary when there is none", () => {
    expect(computeComposition([], [], 0).summary).not.toContain("System");
    expect(computeComposition([], [], 10).summary).toContain("System");
  });
});

describe("contextWindowUsage", () => {
  it("uses the reported token count when there is one", () => {
    const usage = contextWindowUsage(50_000, 999_999, 200_000);
    expect(usage.contextWindowFraction).toBeCloseTo(0.25);
    expect(usage.contextWindowEstimated).toBe(false);
  });

  it("estimates from characters before the first reply", () => {
    // Treating "no token count yet" as a full window would draw a brand-new
    // session as a context window at capacity.
    const usage = contextWindowUsage(null, 40_000, 200_000);
    expect(usage.contextWindowFraction).toBeCloseTo(0.05);
    expect(usage.contextWindowEstimated).toBe(true);
  });

  it("never reports more than a full window", () => {
    expect(contextWindowUsage(500_000, 0, 200_000).contextWindowFraction).toBe(1);
    expect(contextWindowUsage(null, 8_000_000, 200_000).contextWindowFraction).toBe(1);
  });

  it("reports nothing when the model's window is unknown", () => {
    // Null means unknown, and the bar renders that differently from zero.
    expect(contextWindowUsage(1_000, 4_000, null).contextWindowFraction).toBeNull();
    expect(contextWindowUsage(1_000, 4_000, undefined).contextWindowFraction).toBeNull();
    expect(contextWindowUsage(1_000, 4_000, 0).contextWindowFraction).toBeNull();
  });
});

describe("latestInputTokens", () => {
  it("takes the most recent assistant turn that reported one", () => {
    expect(
      latestInputTokens([
        message("assistant", "old", 10),
        message("assistant", "new", 20),
        message("user", "no tokens here"),
      ]),
    ).toBe(20);
  });

  it("ignores user turns even if they carry a count", () => {
    expect(latestInputTokens([message("user", "x", 99)])).toBeNull();
  });

  it("returns null before the first reply", () => {
    expect(latestInputTokens([message("user", "hello")])).toBeNull();
    expect(latestInputTokens([])).toBeNull();
  });
});

/**
 * The branch the composition route used to own. It moved to the client along
 * with the arithmetic, so it needs covering here rather than by a request.
 */
describe("sessionComposition", () => {
  it("reports nothing for a session with no messages and no system prompt", () => {
    expect(
      sessionComposition({
        contextWindow: null,
        messages: [],
        systemPromptChars: 0,
        toolCalls: [],
      }),
    ).toEqual(EMPTY_COMPOSITION);
  });

  it("still draws a brand-new session that has only a system prompt", () => {
    // The floor every conversation starts from — the reason the bar can render
    // before anybody has said anything.
    const result = sessionComposition({
      contextWindow: null,
      messages: [],
      systemPromptChars: 400,
      toolCalls: [],
    });

    expect(result).not.toEqual(EMPTY_COMPOSITION);
    expect(result.systemPromptFraction).toBe(1);
  });

  it("splits a conversation across its parts", () => {
    const result = sessionComposition({
      contextWindow: null,
      messages: [message("user", "a".repeat(25)), message("assistant", "b".repeat(25))],
      systemPromptChars: 25,
      toolCalls: [tool("c".repeat(25))],
    });

    expect(result.systemPromptFraction).toBeCloseTo(0.25);
    expect(result.userFraction).toBeCloseTo(0.25);
    expect(result.assistantFraction).toBeCloseTo(0.25);
    expect(result.toolResultFraction).toBeCloseTo(0.25);
  });

  it("prefers a reported token count over estimating from characters", () => {
    const result = sessionComposition({
      contextWindow: 1_000,
      messages: [message("assistant", "x".repeat(4_000), 250)],
      systemPromptChars: 0,
      toolCalls: [],
    });

    expect(result.contextWindowFraction).toBeCloseTo(0.25);
    expect(result.contextWindowEstimated).toBe(false);
  });

  it("estimates, and says so, before the first reported count", () => {
    const result = sessionComposition({
      contextWindow: 1_000,
      messages: [message("user", "x".repeat(2_000))],
      systemPromptChars: 0,
      toolCalls: [],
    });

    expect(result.contextWindowEstimated).toBe(true);
    expect(result.contextWindowFraction).toBeCloseTo(0.5);
  });
});
