/**
 * Which files the changed-files list shows, given what the commit nav has
 * selected.
 *
 * A pure function and its own module because the rule it encodes was wrong in
 * the panel and invisible there. The panel used to intersect the selected
 * commit's paths with `git status` output:
 *
 * ```ts
 * changedFiles.filter((f) => selectedCommit.files.includes(f.path))
 * ```
 *
 * That is "files this commit touched *and* which are still dirty". A file the
 * agent committed and did not touch again is clean, so git status does not
 * report it, so selecting the commit that changed it showed **nothing** — the
 * failure got worse the tidier the turn was. A commit's file list has to come
 * from the commit.
 *
 * Node-free, like review-types.ts and for the same reason: the review panel is
 * a client component and one hop into a server-only module fails the whole
 * page compile with an error that names neither.
 */

import type {
  ChangedFile,
  CommitFileChange,
  ProjectReview,
  TurnCommit,
} from "@/lib/review/review-types";

/**
 * A commit's file as a row the changed-files list can render.
 *
 * `staged` and `unstaged` are both false, and that is a statement rather than
 * a default: a commit has no index and no worktree, so there is nothing to
 * stage and nothing left unstaged. Every "stage this hunk" affordance in the
 * list keys off these two flags, so this is what turns a commit's rows
 * read-only without a second `readOnly` prop threaded beside them.
 *
 * The porcelain columns get the same treatment: a space means "clean" in that
 * format, which is the honest answer for a file that exists only in history.
 */
export function changedFileFromCommit(change: CommitFileChange): ChangedFile {
  return {
    indexCode: " ",
    oldPath: change.oldPath,
    path: change.path,
    staged: false,
    status: change.status,
    unstaged: false,
    worktreeCode: " ",
  };
}

/**
 * The rows to show for a project, and whether they are a commit's.
 *
 * `null` for `selectedSha` is the working tree — the trailing dot in
 * `ReviewCommitNav`, and the panel's default. A sha that is not among the
 * project's turn commits also falls back to the working tree rather than to an
 * empty list: it means the selection has gone stale (a refetch after the turn
 * mark was cleared, an artifact chip naming a commit from an earlier turn), and
 * showing the working tree is recoverable where showing nothing reads as a
 * project with no changes at all.
 */
export interface CommitScope {
  /** The commit whose files these are, or null for the working tree. */
  commit: TurnCommit | null;
  files: ChangedFile[];
}

export function commitScope(
  project: ProjectReview | null | undefined,
  selectedSha: string | null,
): CommitScope {
  if (!project) return { commit: null, files: [] };

  const commit = selectedSha
    ? (project.turnCommits.find((c) => c.sha === selectedSha) ?? null)
    : null;

  if (!commit) return { commit: null, files: project.changedFiles };

  return {
    commit,
    files: commit.fileChanges.map(changedFileFromCommit),
  };
}
