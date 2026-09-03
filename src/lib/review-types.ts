/**
 * What a review surface is about: the changes in a working copy, and any
 * commits the agent made while the turn ran.
 *
 * Deliberately free of node imports. A client component reads every one of
 * these, and the readers that produce them (src/lib/pi/review-status.ts,
 * src/lib/pi/review-diff.ts) shell out to git. See client-boundary.test.ts for
 * why that separation is load-bearing: the agent package imports child_process
 * at module scope, so one hop from a client component into a server-only
 * module fails the whole page compile with an error that names neither.
 *
 * The same split as src/lib/git-status-display.ts, for the same reason.
 */

/**
 * What happened to a file.
 *
 * Derived from porcelain's two status codes rather than stored as them: the
 * UI wants one word per row, while `indexCode` and `worktreeCode` are kept
 * alongside for the cases where the pair is the interesting part — `MM` is a
 * file modified, staged, and then modified again.
 */
export type ChangeStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "unmerged"
  | "type-changed";

export interface ChangedFile {
  /** Project-relative, exactly as git reports it. Never quoted or escaped. */
  path: string;
  /** Where a rename or copy came from, else null. */
  oldPath: string | null;
  status: ChangeStatus;
  /** Porcelain's first column: the index against HEAD. Space when clean. */
  indexCode: string;
  /** Porcelain's second column: the worktree against the index. */
  worktreeCode: string;
  /** Something about this file is in the index, so a commit would include it. */
  staged: boolean;
  /** Something about this file is not in the index yet. */
  unstaged: boolean;
}

/** A commit made between the turn's start and its end. */
export interface TurnCommit {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  /** ISO 8601, author date. */
  at: string;
  fileCount: number;
}

/**
 * One repository's review state.
 *
 * `startSha` is HEAD as it was when the prompt began. Without it there is no
 * range, so `turnCommits` is empty — which is the honest answer for a session
 * resumed after a restart, rather than a guess at where the turn began.
 */
export interface ProjectReview {
  /** Workspace-relative path: the identity every other route keys by. */
  path: string;
  /** Last segment — the project's own name. */
  name: string;
  changedFiles: ChangedFile[];
  turnCommits: TurnCommit[];
  startSha: string | null;
  headSha: string | null;
  /**
   * Changed files beyond the cap, not listed. A turn that regenerates a
   * lockfile or touches a kibana-sized tree must not try to read hundreds of
   * diffs, and a list that silently stops is worse than one that says so.
   */
  omitted: number;
}

/** The most changed files one project will report in a single read. */
export const CHANGED_FILE_CAP = 200;

/**
 * A run of characters within a line that differs from its counterpart.
 * Offsets are UTF-16 code units from the start of the line, end-exclusive —
 * the units Monaco's columns are measured in, less one.
 */
export interface CharSpan {
  start: number;
  end: number;
}

export type DiffLineKind = "context" | "added" | "removed";

export interface DiffLine {
  kind: DiffLineKind;
  /** 1-based line number in the pre-image; null for an added line. */
  oldLine: number | null;
  /** 1-based line number in the post-image; null for a removed line. */
  newLine: number | null;
  /** The line's content, without the leading +/-/space marker. */
  text: string;
  /**
   * Which characters differ from the line this one replaced. Empty unless the
   * hunk paired this line with a counterpart. Only ever set on added and
   * removed lines: a context line differs from nothing.
   */
  spans: CharSpan[];
  /** git emitted "\ No newline at end of file" after this line. */
  noNewline: boolean;
}

export interface Hunk {
  /**
   * Position in the file's diff, from zero. This is how a hunk is addressed
   * when it is staged, so it must be stable for a given diff read — and it is
   * only meaningful together with the read it came from.
   */
  index: number;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** The text after the closing `@@`, which git fills with an enclosing decl. */
  heading: string;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  oldPath: string | null;
  /**
   * Everything from `diff --git` through the `+++` line, verbatim. Kept
   * because a patch built from a subset of hunks needs this back unchanged;
   * regenerating it is how a generated patch stops applying.
   */
  header: string;
  hunks: Hunk[];
  /** git declined to diff it. There is nothing to show and nothing to stage. */
  binary: boolean;
  /** A mode change with no content change: real, and with no hunks. */
  modeChangeOnly: boolean;
}

/**
 * Every project a session touches, and whether this is worth showing.
 *
 * `changedThisTurn` is the auto-open decision and is deliberately separate
 * from "is anything dirty": a tree that was already dirty before the prompt
 * ran is still listed, because a commit would include it and hiding it would
 * be a lie, but it does not open a panel on its own.
 */
export interface SessionReview {
  projects: ProjectReview[];
  /** Digest of the whole state, and what a dismissal is recorded against. */
  fingerprint: string;
  changedThisTurn: boolean;
  /** The operator has already dismissed or committed this exact state. */
  reviewed: boolean;
}

/** Total changed files across every project, for a count in the header. */
export const totalChangedFiles = (review: SessionReview): number =>
  review.projects.reduce((sum, project) => sum + project.changedFiles.length, 0);

/** Total commits the agent made this turn, across every project. */
export const totalTurnCommits = (review: SessionReview): number =>
  review.projects.reduce((sum, project) => sum + project.turnCommits.length, 0);

/** Nothing to review: no changed file and no commit, anywhere. */
export const isEmptyReview = (review: SessionReview): boolean =>
  totalChangedFiles(review) === 0 && totalTurnCommits(review) === 0;
