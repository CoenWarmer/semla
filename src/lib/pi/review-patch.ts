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
 */

import type { FileDiff, Hunk } from "@/lib/review-types";

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
 * A patch containing `selected` hunks of `file`, or null if there is nothing
 * to apply.
 *
 * A file whose change carries no hunks at all — a mode change, or a rename
 * with no edits — yields the header on its own, which is a complete patch and
 * the only way to stage that change.
 */
export function buildPatch(
  file: FileDiff,
  selected: readonly number[],
): string | null {
  if (file.binary) return null;

  const wanted = new Set(selected);
  const hunks = file.hunks.filter((hunk) => wanted.has(hunk.index));

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

/** Every hunk in a file, for "stage this whole file". */
export const allHunkIndexes = (file: FileDiff): number[] =>
  file.hunks.map((hunk) => hunk.index);
