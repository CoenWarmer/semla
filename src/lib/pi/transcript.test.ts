import { describe, expect, it } from "vitest";

import { buildTranscript, getThinkingText, liveMessageRows, type PiMessage } from "@/lib/pi/transcript";
import type { TranscriptRow } from "@/lib/pi/session/session-file";

const assistant = (content: unknown): PiMessage =>
  ({ content, role: "assistant" }) as PiMessage;

describe("getThinkingText", () => {
  it("reads the reasoning pi records alongside the text and tool calls", () => {
    // The exact shape found in .semla-sessions/*.jsonl.
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

const row = (id: string, parentId: string | null, type = "message"): TranscriptRow => ({
  created_at: "2026-08-31T09:00:00.000Z",
  id,
  payload: { entry: { id, parentId, type } },
});

const customMessageRow = (
  id: string,
  parentId: string | null,
  customType: string,
  content: string,
): TranscriptRow => ({
  created_at: "2026-08-31T09:00:00.000Z",
  id,
  payload: {
    entry: { id, parentId, type: "custom_message", customType, content } as never,
  },
});

describe("liveMessageRows", () => {
  it("defaults to the live path when no leaf is named", () => {
    const rows = [
      row("a", null),
      row("b1", "a"),
      row("b2", "a"),
    ];

    expect(liveMessageRows(rows).map((r) => r.id)).toEqual(["a", "b2"]);
  });

  it("walks to the tip of the branch a named leaf sits on", () => {
    const rows = [
      row("a", null),
      row("b1", "a"),
      row("c1", "b1"),
      row("b2", "a"),
    ];

    expect(liveMessageRows(rows, "b1").map((r) => r.id)).toEqual(["a", "b1", "c1"]);
  });

  it("attaches wiki auto-recall content to the message it was injected after", () => {
    // Mirrors session-file.test.ts's disk-path coverage: the database mirror
    // must attribute the same way, since getTranscript falls back to it
    // whenever the .jsonl file is missing.
    const rows = [
      row("a", null),
      customMessageRow("r", "a", "wiki-recall-context", "## Relevant Wiki Knowledge"),
      row("b", "r"),
    ];

    const result = liveMessageRows(rows);

    expect(result.map((r) => r.id)).toEqual(["a", "b"]);
    expect(result.find((r) => r.id === "a")!.wikiRecall).toBe("## Relevant Wiki Knowledge");
    expect(result.find((r) => r.id === "b")!.wikiRecall).toBeUndefined();
  });

  it("ignores a custom_message of a different customType", () => {
    const rows = [
      row("a", null),
      customMessageRow("c", "a", "wiki-session-notice", "Wiki active"),
      row("b", "c"),
    ];

    const result = liveMessageRows(rows);
    expect(result.every((r) => r.wikiRecall === undefined)).toBe(true);
  });

  it("walks past the wiki's own session-notice to find the triggering message", () => {
    // The regression this pins: on a session's first turn, the real chain is
    // user -> wiki-session-notice -> wiki-recall-context -> assistant, so the
    // recall entry's direct parentId names the notice, not the user message.
    const rows = [
      row("a", null),
      customMessageRow("notice", "a", "wiki-session-notice", "Wiki active"),
      customMessageRow("r", "notice", "wiki-recall-context", "## Relevant Wiki Knowledge"),
      row("b", "r"),
    ];

    const result = liveMessageRows(rows);

    expect(result.map((r) => r.id)).toEqual(["a", "b"]);
    expect(result.find((r) => r.id === "a")!.wikiRecall).toBe("## Relevant Wiki Knowledge");
  });
});

const rowWithMessage = (
  id: string,
  parentId: string | null,
  role: string,
  text: string,
  wikiRecall?: string,
): TranscriptRow => ({
  created_at: "2026-08-31T09:00:00.000Z",
  id,
  payload: {
    entry: {
      id,
      parentId,
      type: "message",
      message: { content: [{ text, type: "text" }], role },
    },
  },
  ...(wikiRecall ? { wikiRecall } : {}),
});

describe("buildTranscript", () => {
  it("carries a row's wikiRecall through to its SessionTranscriptEntry", () => {
    const { messages } = buildTranscript([
      rowWithMessage("a", null, "user", "what does this do?", "## Relevant Wiki Knowledge"),
      rowWithMessage("b", "a", "assistant", "the answer"),
    ]);

    expect(messages.find((m) => m.id === "a")?.wikiRecall).toBe(
      "## Relevant Wiki Knowledge",
    );
    expect(messages.find((m) => m.id === "b")?.wikiRecall).toBeUndefined();
  });
});
