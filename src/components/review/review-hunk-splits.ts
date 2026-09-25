"use client";

/**
 * Where the operator has cut a hunk.
 *
 * Splitting is a view of a hunk, not a change to one: nothing is written to
 * the repository until a part is staged, and git has no way to record "this
 * hunk is in three pieces" in the first place. So the boundaries are kept in
 * Semla's state directory (review-split-store.ts), and the parts are
 * re-derived from the freshly fetched hunk on every render (`applySplits`)
 * rather than stored.
 *
 * **Recorded against a hunk of the staging diffs, not of `full`.** A cut is
 * made on something the operator is about to stage or unstage, so it belongs
 * to the `unstaged` or `staged` hunk that action addresses (see
 * review-hunk-targets.ts for why the editor draws those rather than `full`'s).
 *
 * **Keyed by `splitKey`, not by `Hunk.index`.** An index addresses a position
 * in one diff read and renumbers the moment anything is staged, so a split
 * recorded against index 2 would be sitting on a different hunk after the
 * next refetch. The key is the direction, the one side of the hunk's range
 * that staging a *sibling* cannot move — the worktree side of an unstaged
 * hunk, the HEAD side of a staged one; the other side is the index, which
 * every stage elsewhere in the file shifts — and the hunk's lines.
 *
 * The lines are what make staging a *part* retire the key. A range alone does
 * not: stage only the removal of a one-line replacement and the unstaged
 * hunk that remains has exactly the worktree span it had before, so a cut
 * recorded against the old hunk would be re-applied to a different one. The
 * entry becomes unreachable instead, and the splits route prunes it on the
 * next save.
 *
 * Boundaries use the same convention as `splitHunkAt`: a count of lines in the
 * part before the cut, so a hunk of N lines admits boundaries `1..N-1`.
 */

import { useReviewSplits } from "@/hooks/use-review-splits";
import { splitHunkAt } from "@/lib/review/review-hunk-split";
import { splitKey } from "@/lib/review/review-split-key";
import type { Hunk } from "@/lib/review/review-types";

import type { StageDirection } from "./review-hunk-match";

const NO_SPLITS: readonly number[] = [];

/**
 * `hunk` cut at every boundary in `boundaries`, in file order \u2014 N boundaries
 * give N+1 parts.
 *
 * Sorts and de-duplicates its input, and drops anything outside
 * `1..lines.length - 1`. A caller's boundaries can be stale: they were
 * recorded against a hunk read earlier, and the operator may have edited the
 * file since and shortened it. `splitHunkAt` throws on an out-of-range
 * boundary \u2014 correctly, because a part with no lines is a bug in a caller
 * that computed one \u2014 so the filtering happens here, where staleness is
 * expected rather than exceptional.
 *
 * Cuts are applied left to right against the remaining tail, so each
 * boundary is translated into the tail's own coordinates as it goes. Given
 * boundaries `[2, 5]` the first cut yields lines `0..2` and `2..N`; the
 * second cut of the tail is therefore at `5 - 2`, not at 5.
 */
export function applySplits(hunk: Hunk, boundaries: readonly number[]): Hunk[] {
  const usable = [...new Set(boundaries)]
    .filter(
      (boundary) =>
        Number.isInteger(boundary) &&
        boundary >= 1 &&
        boundary < hunk.lines.length,
    )
    .sort((a, b) => a - b);

  if (usable.length === 0) return [hunk];

  const parts: Hunk[] = [];
  let remainder = hunk;
  let consumed = 0;

  for (const boundary of usable) {
    const [head, tail] = splitHunkAt(remainder, boundary - consumed);
    parts.push(head);
    remainder = tail;
    consumed = boundary;
  }

  parts.push(remainder);
  return parts;
}

/** One place the operator can cut, and the row the cut is drawn above. */
export interface SplitBoundary {
  /**
   * The boundary as `addSplit`/`splitHunkAt` take it: an offset into the
   * *parent* hunk's `lines`, not into the part it was found in. The parts are
   * a view; the state is recorded against the hunk the diff actually has.
   */
  boundary: number;
  /**
   * 1-based line in the new file to anchor the button to. The cut belongs at
   * the top edge of this row, which is the row that begins the part after it.
   */
  line: number;
}

/**
 * Every cut still available across `parts` — one between each adjacent pair
 * of lines *within* a part that has a change on both sides of it, and none at
 * the joins, which are cuts already made.
 *
 * A cut with only context on one side produces a part that stages nothing,
 * and leaves every change in the other part — so staging that one stages
 * exactly what the uncut hunk would have. git's `-U3` puts three such lines
 * before and after every hunk, which is where a naive "every pair of lines"
 * put buttons outside the bracket the operator was looking at.
 *
 * A removed line has no line in the new file to anchor to (its content is
 * gone), the same problem `buildDecorations`'s `removed-marker` case has. The
 * nearest following surviving line is used, then the nearest preceding one,
 * then the *hunk's* own `newStart` — in that order, because the removal's
 * own position in the new file *is* the line that now occupies it.
 *
 * The search runs over every part's lines, not just the one the boundary
 * sits in: a part produced by a split can be nothing but removals (an
 * isolated removal run, or a trailing/leading slice), and such a part has no
 * surviving line of its own to anchor to at all. Searching only within it
 * then fell through to that part's own `newStart` — which is one line past
 * everything the *hunk* actually spans for every part after the first, since
 * `newStart` counts every non-removed line already consumed ahead of it.
 * Concatenating the parts first restores the one thing that search needs
 * and a lone part cannot supply: the surviving lines on either side of it,
 * wherever they actually live.
 */
export function splitBoundaries(parts: readonly Hunk[]): SplitBoundary[] {
  const boundaries: SplitBoundary[] = [];
  const lines = parts.flatMap((part) => part.lines);
  const fallback = Math.max(1, parts[0]?.newStart ?? 1);
  let offset = 0;

  for (const part of parts) {
    const firstChange = part.lines.findIndex((line) => line.kind !== "context");
    const lastChange = part.lines.findLastIndex((line) => line.kind !== "context");

    // `index` is the first line after the cut, so both sides hold a change
    // exactly when `firstChange < index <= lastChange`. A part with no change
    // at all has both at -1 and the loop does not run.
    for (let index = firstChange + 1; index <= lastChange; index += 1) {
      boundaries.push({
        boundary: offset + index,
        line: anchorLineAt(lines, offset + index, fallback),
      });
    }
    offset += part.lines.length;
  }

  return boundaries;
}

/**
 * Every cut already made across `parts` — the joins `splitBoundaries` skips —
 * anchored the same way, so a merge button sits where the split button that
 * made the cut did.
 */
export function joinBoundaries(parts: readonly Hunk[]): SplitBoundary[] {
  const lines = parts.flatMap((part) => part.lines);
  const fallback = Math.max(1, parts[0]?.newStart ?? 1);
  const joins: SplitBoundary[] = [];
  let offset = 0;

  for (const part of parts.slice(0, -1)) {
    offset += part.lines.length;
    joins.push({ boundary: offset, line: anchorLineAt(lines, offset, fallback) });
  }

  return joins;
}

/** The new-file line the row at `index` of the hunk's own concatenated
 * `lines` occupies, or the nearest one either side of it. See
 * `splitBoundaries`. */
function anchorLineAt(
  lines: readonly Hunk["lines"][number][],
  index: number,
  fallback: number,
): number {
  for (let at = index; at < lines.length; at += 1) {
    const line = lines[at].newLine;
    if (line !== null) return line;
  }
  for (let at = index - 1; at >= 0; at -= 1) {
    const line = lines[at].newLine;
    if (line !== null) return line;
  }
  return fallback;
}

export interface HunkSplits {
  /** Every boundary recorded, keyed by `splitKey`. Read by the editor. */
  splits: Readonly<Record<string, readonly number[]>>;
  /** Record a cut. Idempotent: the same boundary twice is one boundary. */
  addSplit: (direction: StageDirection, hunk: Hunk, boundary: number) => void;
  /** Undo one cut, rejoining the two parts either side of it. */
  removeSplit: (direction: StageDirection, hunk: Hunk, boundary: number) => void;
}

/**
 * The split state for one open file, persisted in Semla's state directory
 * (see review-split-store.ts) so a cut survives a reload.
 *
 * Dead entries are not pruned here. A hunk whose key has disappeared from the
 * fetched list is simply never looked up again, and pruning on the client
 * would mean an effect that writes state derived from a prop that changes on
 * every staging refetch, which is what `react/set-state-in-effect` exists to
 * stop. The splits route prunes on every save instead, against a diff it
 * reads itself.
 */
export function useHunkSplits(sessionId: string, project: string, path: string): HunkSplits {
  const { save, splits } = useReviewSplits(sessionId, project, path);

  const addSplit = (direction: StageDirection, hunk: Hunk, boundary: number) => {
    const key = splitKey(direction, hunk);
    save((current) => {
      const existing = current[key] ?? NO_SPLITS;
      if (existing.includes(boundary)) return current;
      return { ...current, [key]: [...existing, boundary].sort((a, b) => a - b) };
    });
  };

  const removeSplit = (direction: StageDirection, hunk: Hunk, boundary: number) => {
    const key = splitKey(direction, hunk);
    save((current) => {
      const existing = current[key];
      if (!existing?.includes(boundary)) return current;

      const { [key]: _removed, ...rest } = current;
      const remaining = existing.filter((entry) => entry !== boundary);
      return remaining.length === 0 ? rest : { ...rest, [key]: remaining };
    });
  };

  return { addSplit, removeSplit, splits };
}
