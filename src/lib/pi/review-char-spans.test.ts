import { describe, expect, it } from "vitest";

import {
  changedSpans,
  commonPrefix,
  commonSuffix,
  tokenize,
} from "./review-char-spans.ts";

/** The substrings a span list actually selects — what the editor will colour. */
const selected = (text: string, spans: Array<{ end: number; start: number }>) =>
  spans.map((span) => text.slice(span.start, span.end));

describe("commonPrefix / commonSuffix", () => {
  it("counts the shared ends", () => {
    expect(commonPrefix("readGitStatus", "readGitState")).toBe(11);
    // Only the adjacent run counts: "abcz" and "abz" share the trailing "z"
    // and stop there, because "c" and "b" differ.
    expect(commonSuffix("abcz", "abz", 0)).toBe(1);
    expect(commonSuffix("xxabz", "abz", 0)).toBe(3);
  });

  it("never counts the same character in both ends", () => {
    // Without the prefix guard the middle "a" is claimed twice and the span
    // comes out inverted.
    const prefix = commonPrefix("aa", "aaa");
    expect(prefix).toBe(2);
    expect(commonSuffix("aa", "aaa", prefix)).toBe(0);
  });
});

describe("tokenize", () => {
  it("keeps identifiers whole and punctuation separate", () => {
    expect(tokenize("foo_bar(baz)")).toEqual([
      "foo_bar",
      "(",
      "baz",
      ")",
    ]);
  });

  it("keeps whitespace as its own token so offsets stay exact", () => {
    expect(tokenize("a  b").join("")).toBe("a  b");
  });
});

describe("changedSpans", () => {
  it("finds nothing in an identical line", () => {
    expect(changedSpans("const x = 1;", "const x = 1;")).toEqual([]);
  });

  it("colours only the characters that actually differ", () => {
    // Not "State": "readGitStat" is shared, so the change is "us" -> "e".
    // Reporting the whole differing word would be easier and less true.
    const before = "  return readGitStatus(path);";
    const after = "  return readGitState(path);";
    expect(selected(after, changedSpans(before, after))).toEqual(["e"]);
  });

  it("colours a changed argument, not the call around it", () => {
    const before = "const status = readGitStatus(projectPath);";
    const after = "const status = readGitStatus(absolutePath);";
    expect(selected(after, changedSpans(before, after))).toEqual(["absolute"]);
  });

  it("reports two separate edits on one line separately", () => {
    // The whole point of the token pass: a prefix/suffix trim alone would
    // return one span swallowing the untouched middle.
    const before = "call(alpha, beta, gamma)";
    const after = "call(ALPHA, beta, GAMMA)";
    expect(selected(after, changedSpans(before, after))).toEqual([
      "ALPHA",
      "GAMMA",
    ]);
  });

  it("spans an insertion where the other side has nothing", () => {
    const before = "const x = 1;";
    const after = "const x = 1; // why";
    expect(selected(after, changedSpans(before, after))).toEqual([" // why"]);
  });

  it("is asymmetric by design: swap the arguments for the other side", () => {
    const before = "let total = 0";
    const after = "let total = 1";
    expect(selected(after, changedSpans(before, after))).toEqual(["1"]);
    expect(selected(before, changedSpans(after, before))).toEqual(["0"]);
  });

  it("yields nothing for a line that replaced nothing", () => {
    expect(changedSpans("", "")).toEqual([]);
    expect(changedSpans("anything", "")).toEqual([]);
  });

  it("drops a span that would colour only whitespace", () => {
    // Re-indentation is already visible as a changed line; a coloured run of
    // blanks reads as a rendering fault.
    expect(changedSpans("  x = 1", "      x = 1")).toEqual([]);
  });

  it("falls back to one coarse span rather than churning on minified lines", () => {
    const before = `a(${"x,".repeat(500)})`;
    const after = `a(${"y,".repeat(500)})`;
    const spans = changedSpans(before, after);
    expect(spans).toHaveLength(1);
    // Still bounded to the line, and still starts after the shared "a(".
    expect(spans[0].start).toBeGreaterThanOrEqual(2);
    expect(spans[0].end).toBeLessThanOrEqual(after.length);
  });

  it("keeps every span inside the line it describes", () => {
    const pairs: Array<[string, string]> = [
      ["", "new line"],
      ["removed entirely", "x"],
      ["  spaced  ", "\tspaced\t"],
      ["ünïcode ok", "ünicode ok"],
      ["}", "});"],
    ];

    for (const [before, after] of pairs) {
      for (const span of changedSpans(before, after)) {
        expect(span.start).toBeGreaterThanOrEqual(0);
        expect(span.end).toBeLessThanOrEqual(after.length);
        expect(span.end).toBeGreaterThan(span.start);
      }
    }
  });
});
