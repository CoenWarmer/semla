/**
 * Cutting one hunk into smaller hunks.
 *
 * A hunk is the unit git offers for staging, and it is chosen by git's own
 * `-U3` context rule rather than by anything the operator meant: two edits
 * three lines apart are one hunk and are staged together, whether or not
 * they belong in the same commit. Splitting is how the operator gets the
 * unit back — the same thing `git add --patch`'s `s` does, except that git's
 * own `s` refuses whenever the two changes are not separated by a context
 * line, and this does not: a split here is an arbitrary cut between two
 * adjacent entries of `hunk.lines`.
 *
 * Everything here is pure arithmetic over `Hunk`, deliberately free of git,
 * of node, and of the patch text it eventually feeds
 * (src/lib/pi/review/review-patch.ts renders a slice exactly as it renders a
 * whole hunk, because a slice *is* a hunk).
 *
 * **Indices are into `hunk.lines`, never file line numbers.** A hunk's
 * `lines` array interleaves context, added and removed entries in file
 * order, and only some of them exist on each side of the diff — so there is
 * no single line number that addresses a position in it. `start`/`end`/
 * `boundary` below are all offsets into that array.
 *
 * The header arithmetic is the whole content of this file. A slice's
 * `oldStart` is the parent's plus however many of the skipped lines the
 * pre-image actually contains (everything but an added line); its `newStart`
 * is the parent's plus however many the post-image contains (everything but
 * a removed line). Counting both from the same skipped prefix is what keeps
 * a pure-addition or pure-removal hunk correct, where one of the two counts
 * is zero for the whole slice.
 */

import type { Hunk } from "./review-types";

/** How many of these lines the pre-image has: everything but an addition. */
const oldCount = (lines: readonly { kind: string }[]): number =>
  lines.filter((line) => line.kind !== "added").length;

/** How many the post-image has: everything but a removal. */
const newCount = (lines: readonly { kind: string }[]): number =>
  lines.filter((line) => line.kind !== "removed").length;

/**
 * The hunk covering `hunk.lines.slice(start, end)` — 0-based, end-exclusive,
 * offsets into `lines` and not line numbers.
 *
 * `oldLines`/`newLines` are counted from the lines present rather than
 * scaled from the parent's, the same way `renderHunk` in review-patch.ts
 * counts them: they must describe the text that will be emitted.
 *
 * `heading` and `index` are copied from the parent. The heading is honest —
 * git's `@@ ... @@` text names the enclosing declaration, which a slice is
 * still inside. `index` is not: it addresses a position in a *diff*, and a
 * slice has no position in one. It is carried only so that a caller holding
 * a slice can still say which of the diff's hunks it came out of (see
 * `HunkSelector` in review-patch.ts), and must not be read as this hunk's
 * own address.
 */
export function sliceHunk(hunk: Hunk, start: number, end: number): Hunk {
  const skipped = hunk.lines.slice(0, start);
  const lines = hunk.lines.slice(start, end);

  return {
    heading: hunk.heading,
    index: hunk.index,
    lines,
    newLines: newCount(lines),
    newStart: hunk.newStart + newCount(skipped),
    oldLines: oldCount(lines),
    oldStart: hunk.oldStart + oldCount(skipped),
  };
}

/** Whether there is any cut to make: a one-line hunk has no interior. */
export function isSplittable(hunk: { lines: readonly unknown[] }): boolean {
  return hunk.lines.length > 1;
}

/**
 * `hunk` cut in two at `boundary` — the number of lines that go to the first
 * part, so the valid range is `1..hunk.lines.length - 1` and both parts are
 * non-empty.
 *
 * Throws outside that range rather than clamping. A clamp would return a
 * part with no lines, which renders as a `@@` header describing zero lines:
 * a patch git either rejects or, worse, applies as a no-op — and the caller
 * asking for it has a real bug that a silent empty hunk would hide. The
 * two callers that take a boundary from data rather than from a click
 * (`applySplits`, and `buildPatch`'s object selector) filter for range
 * themselves, because a *stale* boundary is not a bug and must not throw.
 */
export function splitHunkAt(hunk: Hunk, boundary: number): [Hunk, Hunk] {
  if (!Number.isInteger(boundary) || boundary < 1 || boundary >= hunk.lines.length) {
    throw new Error(
      `A split boundary must be an integer in 1..${hunk.lines.length - 1}; got ${boundary}.`,
    );
  }

  return [sliceHunk(hunk, 0, boundary), sliceHunk(hunk, boundary, hunk.lines.length)];
}
