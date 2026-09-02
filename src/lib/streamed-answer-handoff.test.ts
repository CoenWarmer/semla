/**
 * A turn's answer streams in, then the same text arrives again as a stored
 * message. Clearing the streamed copy before the stored one could be rendered
 * left the conversation briefly showing neither — a visible flash, measured at
 * 185ms to 316ms in a captured session.
 */
import { describe, expect, it, vi } from "vitest";

import { handOffStreamedAnswer } from "./streamed-answer-handoff.ts";

describe("handOffStreamedAnswer", () => {
  it("clears the streamed copy only once the transcript has loaded", async () => {
    const order: string[] = [];
    let release: (() => void) | undefined;

    const done = handOffStreamedAnswer({
      clearStreamed: () => order.push("cleared"),
      loadTranscript: () =>
        new Promise<void>((resolve) => {
          order.push("loading");
          release = resolve;
        }),
    });

    // The whole point: mid-refetch, the streamed answer is still on screen.
    expect(order).toEqual(["loading"]);

    release?.();
    await done;

    expect(order).toEqual(["loading", "cleared"]);
  });

  /**
   * Otherwise a failed refetch strands the bubble against a transcript that
   * never comes, and the answer appears twice as soon as anything does load.
   */
  it("clears it even when the transcript fails to load", async () => {
    const clearStreamed = vi.fn();

    await expect(
      handOffStreamedAnswer({
        clearStreamed,
        loadTranscript: () => Promise.reject(new Error("522")),
      }),
    ).rejects.toThrow("522");

    expect(clearStreamed).toHaveBeenCalledTimes(1);
  });

  it("resolves after the clear, so a caller can sequence on it", async () => {
    const order: string[] = [];

    await handOffStreamedAnswer({
      clearStreamed: () => order.push("cleared"),
      loadTranscript: () => Promise.resolve(),
    });
    order.push("after");

    expect(order).toEqual(["cleared", "after"]);
  });
});
