/**
 * The pairing only survives into the transcript as `ask_user`'s result text,
 * so the parser is the whole contract. What matters is that it stays in step
 * with the format ask-user.ts emits — `question\n→ answer`, blocks separated
 * by a blank line — and that a multi-line answer does not lose its tail.
 */
import { describe, expect, it } from "vitest";

import { parseAskUserResult } from "./ask-user-record.ts";

describe("parseAskUserResult", () => {
  it("parses the format ask-user.ts emits", () => {
    const pairs = parseAskUserResult(
      "How prominent?\n→ card\n\nRender live?\n→ persisted",
    );

    expect(pairs).toEqual([
      { answer: "card", question: "How prominent?" },
      { answer: "persisted", question: "Render live?" },
    ]);
  });

  it("keeps every line of a multi-line free-text answer", () => {
    const pairs = parseAskUserResult("Why?\n→ first line\nsecond line");

    expect(pairs).toEqual([
      { answer: "first line\nsecond line", question: "Why?" },
    ]);
  });

  it("keeps a multi-line question with its answer", () => {
    const pairs = parseAskUserResult("Which one\nof these?\n→ the second");

    expect(pairs).toEqual([
      { answer: "the second", question: "Which one\nof these?" },
    ]);
  });

  it("starts a new pair on a second arrow with no blank line between", () => {
    const pairs = parseAskUserResult("A?\n→ a\nB?\n→ b");

    expect(pairs).toEqual([
      { answer: "a\nB?", question: "A?" },
      { answer: "b", question: "" },
    ]);
  });

  it("records the no-answer placeholder the tool writes", () => {
    const pairs = parseAskUserResult("Skipped?\n→ (no answer)");

    expect(pairs).toEqual([{ answer: "(no answer)", question: "Skipped?" }]);
  });

  it("returns nothing for text that is not in the expected shape", () => {
    // A cancellation message has no arrow, so the caller falls back to raw.
    expect(parseAskUserResult("ask_user was cancelled: aborted")).toEqual([]);
    expect(parseAskUserResult(undefined)).toEqual([]);
    expect(parseAskUserResult("   ")).toEqual([]);
  });
});
