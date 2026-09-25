/**
 * Turning a set of recorded cuts into the parts the gutter draws.
 *
 * `applySplits` is exported separately from the hook precisely so this needs
 * no React: the arithmetic is where the bugs are. Two things it must get
 * right, and both are invisible in a one-boundary test — boundaries are
 * translated into the remaining tail's coordinates as the cuts are applied
 * (so `[2, 5]` is not "cut at 2, then cut at 5 of what is left"), and a stale
 * or unsorted list from the hook's state must not reach `splitHunkAt`, which
 * throws.
 */
import { describe, expect, it } from "vitest";

import type { DiffLine, DiffLineKind, Hunk } from "@/lib/review/review-types";

import { applySplits, joinBoundaries, splitBoundaries } from "./review-hunk-splits";

const line = (
  kind: DiffLineKind,
  text: string,
  oldLine: number | null,
  newLine: number | null,
): DiffLine => ({ kind, newLine, noNewline: false, oldLine, spans: [], text });

/**
 * Six lines: context, added, added, context, removed, context — enough to
 * make old- and new-side arithmetic disagree at every boundary.
 *
 *   idx 0  context  old 10  new 10
 *   idx 1  added            new 11
 *   idx 2  added            new 12
 *   idx 3  context  old 11  new 13
 *   idx 4  removed  old 12
 *   idx 5  context  old 13  new 14
 */
const hunk = (): Hunk => ({
  heading: "",
  index: 3,
  lines: [
    line("context", "a", 10, 10),
    line("added", "b", null, 11),
    line("added", "c", null, 12),
    line("context", "d", 11, 13),
    line("removed", "e", 12, null),
    line("context", "f", 13, 14),
  ],
  newLines: 5,
  newStart: 10,
  oldLines: 5,
  oldStart: 10,
});

const shapeOf = (parts: Hunk[]) =>
  parts.map((part) => ({
    newStart: part.newStart,
    oldStart: part.oldStart,
    texts: part.lines.map((entry) => entry.text).join(""),
  }));

describe("applySplits", () => {
  it("returns the hunk untouched when there are no boundaries", () => {
    const original = hunk();
    expect(applySplits(original, [])).toEqual([original]);
  });

  it("cuts once", () => {
    expect(shapeOf(applySplits(hunk(), [2]))).toEqual([
      { newStart: 10, oldStart: 10, texts: "ab" },
      { newStart: 12, oldStart: 11, texts: "cdef" },
    ]);
  });

  it("cuts into three parts, translating the second boundary into the tail", () => {
    // The bug this guards: applying boundary 4 to the tail of a cut at 2
    // would take four lines off the *tail*, producing parts of 2/4/0 lines
    // rather than 2/2/2.
    expect(shapeOf(applySplits(hunk(), [2, 4]))).toEqual([
      { newStart: 10, oldStart: 10, texts: "ab" },
      { newStart: 12, oldStart: 11, texts: "cd" },
      { newStart: 14, oldStart: 12, texts: "ef" },
    ]);
  });

  it("cuts every line apart, and the parts tile the original exactly", () => {
    const parts = applySplits(hunk(), [1, 2, 3, 4, 5]);

    expect(parts).toHaveLength(6);
    expect(shapeOf(parts)).toEqual([
      { newStart: 10, oldStart: 10, texts: "a" },
      { newStart: 11, oldStart: 11, texts: "b" },
      { newStart: 12, oldStart: 11, texts: "c" },
      { newStart: 13, oldStart: 11, texts: "d" },
      { newStart: 14, oldStart: 12, texts: "e" },
      { newStart: 14, oldStart: 13, texts: "f" },
    ]);
    // Every part's lines, concatenated, are the original's in order.
    expect(parts.flatMap((part) => part.lines)).toEqual(hunk().lines);
  });

  it("sorts its input rather than trusting the caller's order", () => {
    // The hook keeps its arrays sorted, but nothing in the type says so and
    // a second caller would have no reason to.
    expect(applySplits(hunk(), [4, 2])).toEqual(applySplits(hunk(), [2, 4]));
  });

  it("de-duplicates a boundary listed twice", () => {
    // A duplicate would otherwise cut at the same place twice, and the second
    // cut of a zero-length tail throws.
    expect(applySplits(hunk(), [2, 2, 4])).toEqual(applySplits(hunk(), [2, 4]));
  });

  it("drops boundaries that no longer fit the hunk", () => {
    // Stale state: these were recorded against a hunk read before the
    // operator edited the file and shortened it.
    const original = hunk();

    expect(applySplits(original, [0])).toEqual([original]);
    expect(applySplits(original, [6])).toEqual([original]);
    expect(applySplits(original, [-1, 99])).toEqual([original]);
    expect(applySplits(original, [2.5])).toEqual([original]);
    // A stale boundary alongside a usable one keeps the usable one.
    expect(shapeOf(applySplits(original, [99, 2]))).toEqual([
      { newStart: 10, oldStart: 10, texts: "ab" },
      { newStart: 12, oldStart: 11, texts: "cdef" },
    ]);
  });

  it("carries the parent's index onto every part", () => {
    // Which is how a part is addressed back to a hunk of the fetched diff —
    // a part has no index of its own. See `HunkSelector`.
    expect(applySplits(hunk(), [2, 4]).map((part) => part.index)).toEqual([
      3, 3, 3,
    ]);
  });
});

describe("joinBoundaries", () => {
  it("is empty for an uncut hunk", () => {
    expect(joinBoundaries([hunk()])).toEqual([]);
  });

  it("returns each cut, anchored where its split button was", () => {
    const parts = applySplits(hunk(), [2, 4]);
    const splitAnchors = splitBoundaries([hunk()]);

    expect(joinBoundaries(parts)).toEqual(
      splitAnchors.filter(({ boundary }) => boundary === 2 || boundary === 4),
    );
  });
});

describe("splitBoundaries", () => {
  it("offers a cut only where both sides of it hold a change", () => {
    // Changes are at 1, 2 and 4. A cut at 1 or 5 would leave a part of
    // nothing but context — the leading/trailing lines `-U3` adds — and the
    // other part would stage exactly what the whole hunk does. The boundary
    // at index 4 is above a removed line, which has no line of its own in
    // the new file, so it anchors to the next surviving one.
    expect(splitBoundaries([hunk()])).toEqual([
      { boundary: 2, line: 12 },
      { boundary: 3, line: 13 },
      { boundary: 4, line: 14 },
    ]);
  });

  it("offers nothing in a hunk whose only change is a single line", () => {
    const single: Hunk = {
      heading: "",
      index: 0,
      lines: [
        line("context", "a", 10, 10),
        line("added", "b", null, 11),
        line("context", "c", 11, 12),
      ],
      newLines: 3,
      newStart: 10,
      oldLines: 2,
      oldStart: 10,
    };

    expect(splitBoundaries([single])).toEqual([]);
  });

  it("offers no cut at a join, and keeps boundaries in the parent's terms", () => {
    // Cut at 2 already: "ab" has one change and nothing left to cut, while
    // "cdef" has changes at its own 0 and 2. The boundaries are offsets into
    // the *parent*, since that is what the split state is recorded against.
    const parts = applySplits(hunk(), [2]);

    expect(splitBoundaries(parts).map((entry) => entry.boundary)).toEqual([
      3, 4,
    ]);
  });

  it("offers nothing once every part is a single line", () => {
    const parts = applySplits(hunk(), [1, 2, 3, 4, 5]);
    expect(splitBoundaries(parts)).toEqual([]);
  });

  it("falls back to the hunk's own start when no line survives at all", () => {
    // A part of nothing but removals: there is no new-file line anywhere in
    // it to anchor to, and `newStart` is the position it used to occupy.
    const removals: Hunk = {
      heading: "",
      index: 0,
      lines: [
        line("removed", "x", 10, null),
        line("removed", "y", 11, null),
      ],
      newLines: 0,
      newStart: 9,
      oldLines: 2,
      oldStart: 10,
    };

    expect(splitBoundaries([removals])).toEqual([{ boundary: 1, line: 9 }]);
  });

  it("anchors into a neighbouring part when its own part is pure removal", () => {
    // The bug this guards: a boundary inside a part made entirely of
    // removed lines used to fall back to *that part's* own `newStart`,
    // which is the line just past everything the parts before it cover —
    // one line past the hunk's own span for every part after the first.
    // Split so the trailing two removed lines become their own part: the
    // boundary between them must still anchor within the hunk, not past it.
    const withTrailingRemoval: Hunk = {
      heading: "",
      index: 0,
      lines: [
        line("context", "a", 10, 10),
        line("added", "b", null, 11),
        line("removed", "c", 11, null),
        line("removed", "d", 12, null),
      ],
      newLines: 2,
      newStart: 10,
      oldLines: 3,
      oldStart: 10,
    };

    const parts = applySplits(withTrailingRemoval, [2]);
    // The tail part is nothing but removals — no new-file line of its own.
    expect(parts[1].lines.every((entry) => entry.newLine === null)).toBe(true);

    // Its one internal boundary (between "c" and "d") must anchor to a line
    // the hunk actually spans (its last surviving line, 11), not to that
    // part's own `newStart` (12 — one past the hunk).
    const hunkEnd = withTrailingRemoval.newStart + withTrailingRemoval.newLines - 1;
    for (const { line: anchoredLine } of splitBoundaries(parts)) {
      expect(anchoredLine).toBeLessThanOrEqual(hunkEnd);
    }
  });
});
