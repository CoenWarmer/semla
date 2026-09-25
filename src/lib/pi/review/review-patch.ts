/**
 * Building a patch that contains only the hunks the operator chose.
 *
 * This is how hunk-level staging actually works, in every tool that offers it:
 * take the diff, keep the selected hunks, hand the result to `git apply
 * --cached`. The whole difficulty is in one place — the `@@` header — and it
 * is worth being explicit about why.
 *
 * A hunk header names two line ranges: where the hunk sits in the pre-image
 * and where it sits in the post-image. The pre-image is the same file for
 * every hunk in the diff, so `oldStart` is correct however few hunks are kept.
 * The post-image is not: skipping a hunk that added three lines moves every
 * later hunk three lines earlier in the result. So `newStart` has to be
 * recomputed from the hunks actually included, and a patch that simply copies
 * the original headers applies cleanly right up until the operator deselects
 * something, then corrupts the file.
 *
 * The header block is copied verbatim rather than regenerated. It carries the
 * mode, the blob indices, and any rename — and a rebuilt one is the usual
 * reason a generated patch stops applying.
 *
 * **A sub-hunk selector requires `--unidiff-zero` at apply time**, which
 * `applyPatch` in review-apply.ts already passes unconditionally. A hunk cut
 * out of the middle of another hunk has fewer than three trailing context
 * lines, and `git apply` reads a short trailing context as a claim that the
 * hunk runs to end-of-file (`apply.c`'s `match_end`) — so without the flag it
 * refuses a perfectly correct slice with "patch does not apply". See the
 * `applyAsRoute` helper in review-patch.test.ts.
 */

import { sliceHunk } from "@/lib/review/review-hunk-split";
import type { FileDiff, Hunk } from "@/lib/review/review-types";

const NO_NEWLINE = "\\ No newline at end of file";

const MARKER = { added: "+", context: " ", removed: "-" } as const;

/**
 * A hunk's body as patch text, and what it does to the line count.
 *
 * The counts come from the lines present rather than from the parsed header:
 * they must describe the text being emitted, and if the two ever disagreed the
 * emitted text is the truth.
 */
function renderHunk(hunk: Hunk, offset: number): { lines: string[]; delta: number } {
  const lines: string[] = [];
  let oldLines = 0;
  let newLines = 0;

  for (const line of hunk.lines) {
    lines.push(`${MARKER[line.kind]}${line.text}`);
    if (line.kind !== "added") oldLines += 1;
    if (line.kind !== "removed") newLines += 1;
    // Must be preserved exactly, and in place: `git apply` rejects a patch
    // whose no-newline marker is missing or misplaced.
    if (line.noNewline) lines.push(NO_NEWLINE);
  }

  // Counts are always written explicitly. git omits ",1" when a range covers a
  // single line, which is valid to emit but one more thing to get wrong.
  const heading = hunk.heading ? ` ${hunk.heading}` : "";
  const header =
    `@@ -${hunk.oldStart},${oldLines} ` +
    `+${hunk.oldStart + offset},${newLines} @@${heading}`;

  return { delta: newLines - oldLines, lines: [header, ...lines] };
}

/**
 * What one entry of a selection names.
 *
 * A bare number is a whole hunk, by its `index` in the diff the selection was
 * made against — the only form that existed before hunk splitting, and still
 * what every caller that stages a whole hunk sends.
 *
 * The object form names a *sub-range* of that hunk: `hunk.lines[range[0]]`
 * up to but not including `hunk.lines[range[1]]`, the same offsets-into-`lines`
 * convention `sliceHunk` uses (see review-hunk-split.ts, which explains why
 * there is no line number that could address this instead). This is how a
 * hunk the operator split in the gutter is staged one part at a time: git's
 * own hunk boundaries are a function of `-U3`, not of what the operator
 * meant, and a slice of a hunk is itself a perfectly good hunk to emit.
 */
export type HunkSelector =
  | number
  | { index: number; range: readonly [number, number] };

/**
 * The hunk a selector actually names, or null when it names nothing in this
 * diff.
 *
 * Null is a normal answer rather than an error: a selection is made against
 * one diff read and applied against another, so it can be stale — the hunk
 * may have been staged already, or the operator may have edited the file and
 * changed its shape. Skipping what no longer exists and applying what does is
 * the honest response; inventing a hunk is not. An out-of-bounds `range` is
 * the same staleness one level down, and is treated the same way.
 */
function resolveSelector(file: FileDiff, selector: HunkSelector): Hunk | null {
  const index = typeof selector === "number" ? selector : selector.index;
  const hunk = file.hunks.find((candidate) => candidate.index === index);
  if (!hunk) return null;
  if (typeof selector === "number") return hunk;

  const [start, end] = selector.range;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || end > hunk.lines.length || start >= end) return null;

  return sliceHunk(hunk, start, end);
}

/**
 * A patch containing `selected` hunks of `file`, or null if there is nothing
 * to apply.
 *
 * A file whose change carries no hunks at all — a mode change, or a rename
 * with no edits — yields the header on its own, which is a complete patch and
 * the only way to stage that change.
 */
export function buildPatch(
  file: FileDiff,
  selected: readonly HunkSelector[],
): string | null {
  if (file.binary) return null;

  /*
   * Resolved first, then sorted by pre-image position — not taken in the
   * order the caller happened to list them.
   *
   * The `offset` the render loop below accumulates is only correct for hunks
   * emitted in ascending file order, since each one's post-image start
   * depends on the net line change of everything emitted before it (see this
   * file's own docblock). While a selection was a set of whole-hunk indexes
   * `file.hunks`' own order gave that for free. A selection can now contain
   * two sub-ranges of the *same* hunk, which `file.hunks` cannot order at
   * all, so the order is established here from the resolved hunks' own
   * headers. `newStart` breaks a tie for determinism only: two selections
   * that do not overlap cannot share an `oldStart` unless one of them is a
   * pure addition, which has no pre-image line of its own to sort by.
   *
   * Deduplicated on the way, which the `Set` of indexes this used to build
   * gave for free: the same selector listed twice is one hunk, and emitting
   * it twice would produce a patch git rejects for overlapping ranges.
   */
  const seen = new Set<string>();
  const hunks = selected
    .filter((selector) => {
      const key =
        typeof selector === "number"
          ? `${selector}`
          : `${selector.index}:${selector.range[0]}:${selector.range[1]}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((selector) => resolveSelector(file, selector))
    .filter((hunk): hunk is Hunk => hunk !== null)
    .sort((a, b) => a.oldStart - b.oldStart || a.newStart - b.newStart);

  if (hunks.length === 0) {
    // Nothing selected. A hunkless file is the exception: there were never any
    // hunks to select, so an empty selection still means "apply this".
    return file.hunks.length === 0 ? `${file.header}\n` : null;
  }

  const body: string[] = [];
  let offset = 0;

  for (const hunk of hunks) {
    const rendered = renderHunk(hunk, offset);
    body.push(...rendered.lines);
    offset += rendered.delta;
  }

  return `${file.header}\n${body.join("\n")}\n`;
}
