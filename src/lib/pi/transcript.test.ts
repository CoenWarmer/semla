import { describe, expect, it } from "vitest";

import { getThinkingText, type PiMessage } from "@/lib/pi/transcript";

const assistant = (content: unknown): PiMessage =>
  ({ content, role: "assistant" }) as PiMessage;

describe("getThinkingText", () => {
  it("reads the reasoning pi records alongside the text and tool calls", () => {
    // The exact shape found in /tmp/semla-pi-sessions/*.jsonl.
    const message = assistant([
      {
        thinking: "This looks like a straightforward task.",
        thinkingSignature: "reasoning",
        type: "thinking",
      },
      { name: "workflow", type: "toolCall" },
      { text: "Done.", type: "text" },
    ]);

    expect(getThinkingText(message)).toBe("This looks like a straightforward task.");
  });

  it("joins multiple thinking blocks in order", () => {
    const message = assistant([
      { thinking: "First.", type: "thinking" },
      { text: "…", type: "text" },
      { thinking: "Second.", type: "thinking" },
    ]);

    expect(getThinkingText(message)).toBe("First.\n\nSecond.");
  });

  it("reports redacted reasoning as withheld rather than leaking the signature", () => {
    const message = assistant([
      {
        redacted: true,
        thinkingSignature: "EncryptedOpaquePayload==",
        type: "thinking",
      },
    ]);

    const thinking = getThinkingText(message);
    expect(thinking).toContain("redacted");
    expect(thinking).not.toContain("EncryptedOpaquePayload==");
  });

  it("returns undefined when the turn carries no reasoning", () => {
    expect(getThinkingText(assistant([{ text: "Hi.", type: "text" }]))).toBeUndefined();
    expect(getThinkingText(assistant("plain string content"))).toBeUndefined();
    expect(getThinkingText(assistant([{ thinking: "   ", type: "thinking" }]))).toBeUndefined();
  });
});
