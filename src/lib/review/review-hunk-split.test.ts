/**
 * The header arithmetic behind splitting a hunk.
 *
 * Pure data in, pure data out: no git repository and no DOM. The real
 * "does git accept this" check lives in review-patch.test.ts, which applies
 * a patch built from a slice against a real index — here the concern is only
 * that the four header numbers describe the lines the slice actually holds,
 * because everything downstream trusts them.
 *
 * The cases that matter are the asymmetric ones. `oldStart` advances only
 * over lines the pre-image has and `newStart` only over lines the post-image
 * has, so a slice that skips a run of pure additions must move `newStart`
 * and leave `oldStart` alone, and a run of pure removals the other way
 * round. Getting that backwards produces a patch that applies cleanly at the
 * wrong offset, which is the failure mode with no visible symptom.
 */
import { describe, expect, it } from "vitest";

import { isSplittable, sliceHunk, splitHunkAt } from "./review-hunk-split";
import type { DiffLine, DiffLineKind, Hunk } from "./review-types";

const line = (
  kind: DiffLineKind,
  text: string,
  oldLine: number | null,
  newLine: number | null,
): DiffLine => ({ kind, newLine, noNewline: false, oldLine, spans: [], text });

const hunkOf = (
  lines: DiffLine[],
  overrides: Partial<Hunk> = {},
): Hunk => ({
  heading: " function thing()",
  index: 0,
  lines,
  newLines: lines.filter((entry) => entry.kind !== "removed").length,
  newStart: 10,
  oldLines: lines.filter((entry) => entry.kind !== "added").length,
  oldStart: 10,
  ...overrides,
});

/** 1 context, 2 additions, 1 context — the shape a small edit produces. */
const mixed = () =>
  hunkOf([
    line("context", "before", 10, 10),
    line("added", "added one", null, 11),
    line("added", "added two", null, 12),
    line("context", "after", 11, 13),
  ]);

const textsOf = (hunk: Hunk) => hunk.lines.map((entry) => entry.text);

describe("sliceHunk", () => {
  it("returns the whole hunk's own header for a full-width slice", () => {
    const hunk = mixed();
    const slice = sliceHunk(hunk, 0, hunk.lines.length);

    expect(slice).toEqual({
      heading: " function thing()",
      index: 0,
      lines: hunk.lines,
      newLines: 4,
      newStart: 10,
      oldLines: 2,
      oldStart: 10,
    });
  });

  it("advances each start only over the lines its own side contains", () => {
    // Skipping [context, added, added]: the pre-image holds one of them, the
    // post-image all three.
    const slice = sliceHunk(mixed(), 3, 4);

    expect(slice.oldStart).toBe(11);
    expect(slice.newStart).toBe(13);
    expect(slice.oldLines).toBe(1);
    expect(slice.newLines).toBe(1);
    expect(textsOf(slice)).toEqual(["after"]);
  });

  it("copies the parent's heading and index onto the slice", () => {
    // `index` is deliberately the parent's: a slice has no position of its
    // own in a diff, and this is how a caller says which hunk it came from.
    const slice = sliceHunk(mixed(), 1, 3);

    expect(slice.heading).toBe(" function thing()");
    expect(slice.index).toBe(0);
  });
});

describe("splitHunkAt", () => {
  it("splits a context/added/added/context hunk after its first line", () => {
    const [first, second] = splitHunkAt(mixed(), 1);

    expect(textsOf(first)).toEqual(["before"]);
    expect(first).toMatchObject({
      newLines: 1,
      newStart: 10,
      oldLines: 1,
      oldStart: 10,
    });

    expect(textsOf(second)).toEqual(["added one", "added two", "after"]);
    // One pre-image line skipped, one post-image line skipped.
    expect(second).toMatchObject({
      newLines: 3,
      newStart: 11,
      oldLines: 1,
      oldStart: 11,
    });
  });

  it("splits the same hunk between its two additions", () => {
    const [first, second] = splitHunkAt(mixed(), 2);

    expect(textsOf(first)).toEqual(["before", "added one"]);
    expect(first).toMatchObject({
      newLines: 2,
      newStart: 10,
      oldLines: 1,
      oldStart: 10,
    });

    // The skipped prefix is one context and one addition: the pre-image has
    // only the context, the post-image has both.
    expect(textsOf(second)).toEqual(["added two", "after"]);
    expect(second).toMatchObject({
      newLines: 2,
      newStart: 12,
      oldLines: 1,
      oldStart: 11,
    });
  });

  it("splits before the last line", () => {
    const [first, second] = splitHunkAt(mixed(), 3);

    expect(textsOf(first)).toEqual(["before", "added one", "added two"]);
    expect(first).toMatchObject({ newLines: 3, oldLines: 1 });
    expect(textsOf(second)).toEqual(["after"]);
    expect(second).toMatchObject({
      newLines: 1,
      newStart: 13,
      oldLines: 1,
      oldStart: 11,
    });
  });

  it("splits recursively down to one-line parts", () => {
    const [head, tail] = splitHunkAt(mixed(), 2);
    const [headA, headB] = splitHunkAt(head, 1);
    const [tailA, tailB] = splitHunkAt(tail, 1);

    // Four single lines, whose headers together tile the parent exactly.
    expect(
      [headA, headB, tailA, tailB].map((part) => ({
        newStart: part.newStart,
        oldStart: part.oldStart,
        text: part.lines[0].text,
      })),
    ).toEqual([
      { newStart: 10, oldStart: 10, text: "before" },
      { newStart: 11, oldStart: 11, text: "added one" },
      { newStart: 12, oldStart: 11, text: "added two" },
      { newStart: 13, oldStart: 11, text: "after" },
    ]);

    expect([headA, headB, tailA, tailB].every((part) => !isSplittable(part))).toBe(
      true,
    );
  });

  it("splits a hunk of pure removals, moving oldStart and not newStart", () => {
    // The post-image contains none of these lines, so every part starts at
    // the same `newStart`: the position the removed run used to occupy.
    const removals = hunkOf(
      [
        line("removed", "gone one", 10, null),
        line("removed", "gone two", 11, null),
        line("removed", "gone three", 12, null),
      ],
      { newLines: 0, newStart: 9, oldLines: 3, oldStart: 10 },
    );

    const [first, second] = splitHunkAt(removals, 1);

    expect(first).toMatchObject({
      newLines: 0,
      newStart: 9,
      oldLines: 1,
      oldStart: 10,
    });
    expect(second).toMatchObject({
      newLines: 0,
      newStart: 9,
      oldLines: 2,
      oldStart: 11,
    });
    expect(textsOf(second)).toEqual(["gone two", "gone three"]);
  });

  it("splits a hunk of pure additions, moving newStart and not oldStart", () => {
    const additions = hunkOf(
      [
        line("added", "new one", null, 10),
        line("added", "new two", null, 11),
        line("added", "new three", null, 12),
      ],
      { newLines: 3, newStart: 10, oldLines: 0, oldStart: 9 },
    );

    const [first, second] = splitHunkAt(additions, 2);

    expect(first).toMatchObject({
      newLines: 2,
      newStart: 10,
      oldLines: 0,
      oldStart: 9,
    });
    expect(second).toMatchObject({
      newLines: 1,
      newStart: 12,
      oldLines: 0,
      oldStart: 9,
    });
  });

  it("refuses a boundary that would leave a part with no lines", () => {
    // A zero-line part renders as a `@@` header describing nothing, which is
    // a patch git either rejects or silently applies as a no-op.
    const hunk = mixed();

    expect(() => splitHunkAt(hunk, 0)).toThrow(/1\.\.3/);
    expect(() => splitHunkAt(hunk, 4)).toThrow(/1\.\.3/);
    expect(() => splitHunkAt(hunk, -1)).toThrow();
    expect(() => splitHunkAt(hunk, 1.5)).toThrow();
  });
});

describe("isSplittable", () => {
  it("is false for a single-line hunk and true for anything longer", () => {
    expect(isSplittable({ lines: [] })).toBe(false);
    expect(isSplittable({ lines: ["one"] })).toBe(false);
    expect(isSplittable({ lines: ["one", "two"] })).toBe(true);
    expect(isSplittable(mixed())).toBe(true);
  });
});
