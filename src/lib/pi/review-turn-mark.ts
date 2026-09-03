/**
 * Where a turn began, so a review can be about that turn.
 *
 * "Changes the agent just made" and "changes in this working copy" are not the
 * same set. A tree that was already dirty yesterday is dirty now, and a panel
 * that opens itself on that has cried wolf. So HEAD and a fingerprint of the
 * dirty set are recorded when a prompt starts, and compared when it ends.
 *
 * Kept beside Semla's other install state rather than in the session
 * directory, for the reason user-settings-store.ts gives: a stray file in the
 * session directory is read as a session by listSessionMeta.
 *
 * Disk is authoritative here with no Postgres mirror, deliberately. A mark is
 * meaningful only between the start and end of one turn on one machine, and a
 * mark that outlives its turn is worse than a missing one — `readTurnCommits`
 * already answers "no range" honestly when there is no sha.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SEMLA_STATE_DIR } from "@/lib/user-settings-store";
import type { ChangedFile } from "@/lib/review-types";

export interface ProjectMark {
  /** HEAD when the turn began, or null in a repository with no commits. */
  head: string | null;
  /**
   * Fingerprint of HEAD together with the dirty set as the turn began. One
   * value rather than two because the question asked of it is a single one:
   * is the working copy in a different state than it was?
   */
  state: string;
}

export interface ReviewTurnMark {
  startedAt: string;
  /** Keyed by workspace-relative project path, as every other route keys. */
  projects: Record<string, ProjectMark>;
  /**
   * The fingerprint the operator last dismissed or committed. The panel does
   * not reopen itself on a state that has already been seen, so dismissing is
   * not undone by the next unrelated refetch.
   */
  reviewed: string | null;
}

const REVIEW_DIR = "review";

const markPath = (sessionId: string, dir: string) =>
  join(dir, REVIEW_DIR, `${sessionId}.json`);

/**
 * A stable digest of what is dirty, ignoring order.
 *
 * The status codes are part of it: staging a file changes nothing about which
 * paths are dirty but does change what a commit would include, and the panel
 * should notice. Content is not — a fingerprint that changed on every
 * keystroke would defeat the dismissal it exists to support.
 */
export function fingerprint(
  head: string | null,
  files: readonly ChangedFile[],
): string {
  const body = files
    .map((file) => `${file.indexCode}${file.worktreeCode} ${file.path}`)
    .sort()
    .join("\n");

  return createHash("sha256")
    .update(`${head ?? "none"}\n${body}`)
    .digest("hex")
    .slice(0, 16);
}

export function readTurnMark(
  sessionId: string,
  dir = SEMLA_STATE_DIR,
): ReviewTurnMark | null {
  try {
    return JSON.parse(
      readFileSync(markPath(sessionId, dir), "utf8"),
    ) as ReviewTurnMark;
  } catch {
    return null;
  }
}

export function writeTurnMark(
  sessionId: string,
  mark: ReviewTurnMark,
  dir = SEMLA_STATE_DIR,
): void {
  try {
    mkdirSync(join(dir, REVIEW_DIR), { recursive: true });
    writeFileSync(markPath(sessionId, dir), JSON.stringify(mark, null, 2));
  } catch {
    // A mark that cannot be written costs the auto-open, not the turn. The
    // panel is still reachable by hand and `git status` still answers.
  }
}

/**
 * Record the operator's verdict on a state without disturbing the turn's
 * start marks: they are what "since this turn began" still means.
 */
export function markReviewed(
  sessionId: string,
  reviewed: string,
  dir = SEMLA_STATE_DIR,
): void {
  const existing = readTurnMark(sessionId, dir);
  writeTurnMark(
    sessionId,
    {
      projects: existing?.projects ?? {},
      reviewed,
      startedAt: existing?.startedAt ?? new Date().toISOString(),
    },
    dir,
  );
}

export function clearTurnMark(sessionId: string, dir = SEMLA_STATE_DIR): void {
  try {
    rmSync(markPath(sessionId, dir));
  } catch {
    // Already absent, which is the state this was asking for.
  }
}
