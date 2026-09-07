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

import type { FileDiff, Hunk } from "@/lib/review-types";

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
