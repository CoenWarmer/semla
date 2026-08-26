import { describe, expect, it } from "vitest";

import { compactAgentHistory } from "./agent-history.ts";

describe("compactAgentHistory thinking capture", () => {
  it("keeps a subagent's reasoning as its own entry, before the turn it explains", () => {
    const entries = compactAgentHistory([
      { content: [{ text: "List 10 cute animals.", type: "text" }], role: "user" },
      {
        content: [
          {
            thinking: "Simple listing task — no tools needed.",
            thinkingSignature: "reasoning",
            type: "thinking",
          },
          { text: "Puppies\nKittens", type: "text" },
        ],
        role: "assistant",
      },
    ]);

    expect(entries.map((entry) => entry.kind)).toEqual(["text", "thinking", "text"]);
    expect(entries[1]).toMatchObject({
      kind: "thinking",
      role: "assistant",
      text: "Simple listing task — no tools needed.",
    });
  });

  it("reports redacted reasoning as withheld rather than leaking the signature", () => {
    const [entry] = compactAgentHistory([
      {
        content: [
          { redacted: true, thinkingSignature: "EncryptedOpaquePayload==", type: "thinking" },
        ],
        role: "assistant",
      },
    ]);

    expect(entry.kind).toBe("thinking");
    expect(entry.text).toContain("redacted");
    expect(entry.text).not.toContain("EncryptedOpaquePayload==");
  });

  it("drops an empty thinking block instead of emitting a blank entry", () => {
    const entries = compactAgentHistory([
      {
        content: [
          { thinking: "   ", type: "thinking" },
          { text: "Answer.", type: "text" },
        ],
        role: "assistant",
      },
    ]);

    expect(entries.map((entry) => entry.kind)).toEqual(["text"]);
  });

  it("leaves tool calls and results untouched", () => {
    const entries = compactAgentHistory([
      {
        content: [
          { thinking: "Need to check the tests.", type: "thinking" },
          { arguments: { command: "npm test" }, name: "bash", type: "toolCall" },
        ],
        role: "assistant",
      },
      { content: [{ text: "ok", type: "text" }], role: "toolResult", toolName: "bash" },
    ]);

    expect(entries.map((entry) => entry.kind)).toEqual([
      "thinking",
      "toolCall",
      "toolResult",
    ]);
    expect(entries[1].toolName).toBe("bash");
  });
});
