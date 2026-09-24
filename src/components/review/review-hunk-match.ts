/**
 * Which staging action a hunk the editor is showing actually corresponds to.
 *
 * The editor colours from `full` — the diff against HEAD, so the operator
 * sees everything that changed regardless of what is staged. Staging acts on
 * `unstaged` and `staged` instead, which are two different diffs (worktree
 * against index, and index against HEAD) with their own, independently
 * numbered hunks. A `full` hunk's index means nothing to either of them.
 *
 * Matching is by range rather than by index: a `full` hunk that touches
 * exactly the same lines as one `unstaged` hunk is that hunk, not staged yet.
 * One that matches a `staged` hunk instead is already staged in full. Either
 * way the range has to match exactly on both sides of the diff — old and new
 * — because a partial match means the hunk straddles the boundary between
 * what is staged and what is not, and there is no single hunk on either side
 * to act on. That case is reported honestly as "no action", rather than
 * guessed at.
 */

import type { FileDiff, Hunk } from "@/lib/review/review-types";

import { hunkChangedLineRange } from "./review-decorations";

export type StageDirection = "stage" | "unstage";

export interface HunkAction {
  direction: StageDirection;
  /** The index into whichever diff `direction` acts on — not `full`'s. */
  index: number;
}

const sameRange = (a: Hunk, b: Hunk): boolean =>
  a.oldStart === b.oldStart &&
  a.oldLines === b.oldLines &&
  a.newStart === b.newStart &&
  a.newLines === b.newLines;

/**
 * A hunk's identity across the staged/unstaged boundary, for animating a row
 * moving from one group to the other.
 *
 * `Hunk.index` cannot serve this — it renumbers on every stage (see
 * hunk-cursor-stable-addressing) and is scoped to one diff read, so the
 * same index in the unstaged diff and the staged diff names two unrelated
 * hunks. The range these four fields describe is what actually survives a
 * hunk's move from one diff to the other: staging hunk X turns it into a
 * hunk of the *other* diff with the same old/new line span, which is exactly
 * the identity `matchHunkAction` above already relies on to find a `full`
 * hunk's counterpart. This just names that same signature so a caller can use
 * it as a React `layoutId`.
 *
 * Not a global identity — only meaningful for hunks known to belong to the
 * same file, so callers scope it (e.g. by path) before handing it to Motion.
 */
export const hunkRangeKey = (hunk: Hunk): string =>
  `${hunk.oldStart}:${hunk.oldLines}:${hunk.newStart}:${hunk.newLines}`;

/**
 * The action for one hunk the editor is displaying, or null when this exact
 * range cannot be staged or unstaged as a unit.
 */
export function matchHunkAction(
  hunk: Hunk,
  diffs: { staged: FileDiff | null; unstaged: FileDiff | null },
): HunkAction | null {
  const unstagedMatch = diffs.unstaged?.hunks.find((candidate) =>
    sameRange(hunk, candidate),
  );
  if (unstagedMatch) return { direction: "stage", index: unstagedMatch.index };

  const stagedMatch = diffs.staged?.hunks.find((candidate) =>
    sameRange(hunk, candidate),
  );
  if (stagedMatch) return { direction: "unstage", index: stagedMatch.index };

  return null;
}

/**
 * `matchHunkAction`'s inverse: which hunk of `full` — the diff the editor
 * actually colours — a staged or unstaged hunk corresponds to.
 *
 * Needed for the keyboard cursor's editor highlight: the cursor addresses a
 * hunk group-relative, into `staged` or `unstaged` (see review-hunk-cursor.ts),
 * but the lines Monaco has open belong to `full`'s numbering. Same range
 * equality either direction, since a hunk's move between diffs preserves its
 * span — the reasoning `hunkRangeKey` above already relies on.
 */
export function matchFullHunk(
  hunk: Hunk,
  full: readonly Hunk[] | null | undefined,
): Hunk | null {
  return full?.find((candidate) => sameRange(hunk, candidate)) ?? null;
}

/**
 * Which hunk, if any, a comment's own line range names, and what staging it
 * would do — for the "Stage hunk" control `ReviewCommentWidgets` offers on
 * a comment that is about a hunk rather than free-standing prose.
 *
 * Exact equality against `hunkChangedLineRange`, not overlap: the same
 * reasoning `matchHunkAction`'s docblock gives for a partial match at the
 * staged/unstaged boundary applies here too. A comment that only overlaps
 * part of a hunk does not name a single hunk to stage as a unit, so it gets
 * no button rather than a guess at which one.
 */
export function matchCommentHunk(
  comment: { startLine: number; endLine: number },
  hunks: readonly Hunk[],
  diffs: { staged: FileDiff | null; unstaged: FileDiff | null },
): HunkAction | null {
  const hunk = hunks.find((candidate) => {
    const range = hunkChangedLineRange(candidate);
    return range.start === comment.startLine && range.end === comment.endLine;
  });
  return hunk ? matchHunkAction(hunk, diffs) : null;
}
