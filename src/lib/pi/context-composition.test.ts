import { describe, expect, it } from "vitest";

import {
  computeComposition,
  contextWindowUsage,
  latestInputTokens,
} from "./context-composition";
import type { SessionToolCall, SessionTranscriptEntry } from "./transcript";

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
