/**
 * The hunks the editor offers to stage or unstage, positioned on the file the
 * operator is looking at.
 *
 * The editor colours `full` — the diff against HEAD — but staging acts on
 * `unstaged` (index → worktree) and `staged` (HEAD → index). Drawing a button
 * per `full` hunk and pairing it with a staging hunk is only sound while every
 * `full` hunk is wholly on one side of the index, and splitting exists
 * precisely to break that: once one part of a hunk is staged, `full` still
 * shows one hunk while `staged` and `unstaged` each hold half of it. A button
 * drawn per `full` hunk then has to claim one direction for all of it, and
 * whichever it claims misrepresents the index.
 *
 * So the buttons are drawn from the staging diffs themselves, one per hunk of
 * each, and a part is always addressed in the hunk it was cut from. What that
 * costs is positioning: `unstaged`'s new side *is* the worktree, but
 * `staged`'s new side is the index, and has to be carried through `unstaged`
 * to land on the line the editor shows. That translation is this module.
 */

import type { FileDiff, Hunk } from "@/lib/review/review-types";

import type { StageDirection } from "./review-hunk-match";

export interface StagingTarget {
  direction: StageDirection;
  /** The hunk as the staging diff has it — what a selector addresses. */
  hunk: Hunk;
  /**
   * The same hunk with every `newLine` (and `newStart`) in worktree
   * coordinates, for placing widgets. `lines` is index-for-index the same as
   * `hunk.lines`, so an offset computed on one addresses the other.
   */
  display: Hunk;
}

/**
 * Where line `line` of the index sits in the worktree, or null when the
 * worktree has removed it.
 *
 * `unstaged` is the index → worktree diff, so its old side is the index. A
 * line before a hunk moves by the net line change of every hunk above it; a
 * line inside one is looked up in that hunk's own lines, where a context line
 * carries both numbers and a removed line has no new one.
 */
export function indexLineToWorktree(
  line: number,
  unstaged: readonly Hunk[],
): number | null {
  const ordered = [...unstaged].sort((a, b) => a.oldStart - b.oldStart);
  let delta = 0;

  for (const hunk of ordered) {
    // A hunk with no old lines inserts *after* old line `oldStart`.
    if (hunk.oldLines === 0) {
      if (line <= hunk.oldStart) break;
      delta += hunk.newLines;
      continue;
    }

    if (line < hunk.oldStart) break;
    if (line < hunk.oldStart + hunk.oldLines) {
      const match = hunk.lines.find((entry) => entry.oldLine === line);
      return match?.newLine ?? null;
    }
    delta += hunk.newLines - hunk.oldLines;
  }

  return line + delta;
}

/** `hunk` of the staged diff, with its new side moved onto the worktree. */
function stagedForDisplay(hunk: Hunk, unstaged: readonly Hunk[]): Hunk {
  const lines = hunk.lines.map((entry) =>
    entry.newLine === null
      ? entry
      : { ...entry, newLine: indexLineToWorktree(entry.newLine, unstaged) },
  );

  // The first line still in the worktree stands in for the start when the
  // index's own first line has been removed there since.
  const newStart =
    indexLineToWorktree(hunk.newStart, unstaged) ??
    lines.find((entry) => entry.newLine !== null)?.newLine ??
    hunk.newStart;

  return { ...hunk, lines, newStart };
}

/** Every hunk that can be staged or unstaged, in the staging diffs' order. */
export function stagingTargets(staging: {
  staged: FileDiff | null;
  unstaged: FileDiff | null;
}): StagingTarget[] {
  const unstagedHunks = staging.unstaged?.hunks ?? [];

  return [
    ...unstagedHunks.map((hunk) => ({
      direction: "stage" as const,
      display: hunk,
      hunk,
    })),
    ...(staging.staged?.hunks ?? []).map((hunk) => ({
      direction: "unstage" as const,
      display: stagedForDisplay(hunk, unstagedHunks),
      hunk,
    })),
  ];
}
