import { describe, expect, it } from "vitest";

import { splitKey } from "./review-split-key";
import type { Hunk } from "./review-types";

const hunk = (text: string): Hunk => ({
  heading: "",
  index: 0,
  lines: [
    { kind: "removed", newLine: null, noNewline: false, oldLine: 1, spans: [], text: "before" },
    { kind: "added", newLine: 1, noNewline: false, oldLine: null, spans: [], text },
  ],
  newLines: 1,
  newStart: 1,
  oldLines: 1,
  oldStart: 1,
});

describe("splitKey", () => {
  it("does not carry the hunk's source text", () => {
    const key = splitKey("stage", hunk("const secret = 1;"));
    expect(key).not.toContain("secret");
    expect(key).toMatch(/^stage:1:1:[0-9a-z]+$/);
  });

  it("tells apart hunks that differ only in content", () => {
    expect(splitKey("stage", hunk("a"))).not.toBe(splitKey("stage", hunk("b")));
  });

  it("is stable for the same hunk", () => {
    expect(splitKey("unstage", hunk("a"))).toBe(splitKey("unstage", hunk("a")));
  });
});
