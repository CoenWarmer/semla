/**
 * Assembling a session's review state, and the one place a caller's idea of
 * "which repository" is turned into a path.
 *
 * `resolveReviewTarget` is that place. The rule it enforces is the one the
 * session git route already sets out: the supplied identifier is checked
 * against the projects *this session* is linked to, and the absolute path is
 * derived from the matched link rather than taken from the request, so the
 * repository is never the caller's to choose.
 *
 * Semla is single-user and loopback-bound, so this is not a defence against a
 * remote attacker. It is a defence against a bug in the panel pointing a
 * commit, a write, or a reset at the wrong repository — which is the failure
 * this whole feature exists to prevent, not to cause.
 */

import { resolveInsideRoot } from "@/lib/pi/workspace/file-browser";
import { seedSnapshots } from "@/lib/pi/artifacts/artifact-snapshot-cache";
import {
  readChangedFiles,
  readCommitsBySha,
  readHeadSha,
} from "@/lib/pi/review/review-status";
import { sessionCommitShasOrdered } from "@/lib/pi/review/review-session-commits";
import {
  fingerprint,
  readTurnMark,
  writeTurnMark,
  type ProjectMark,
} from "@/lib/pi/review/review-turn-mark";
import { otherActiveSessionCount } from "@/lib/pi/session/session-concurrency";
import { projectAbsolutePath, sessionProjects } from "@/lib/pi/session/session-project";
import type { ProjectLink } from "@/lib/pi/session/session-meta";
import type {
  ProjectReview,
  SessionReview,
  TurnCommit,
} from "@/lib/review/review-types";

/** Last segment of a workspace-relative path — the project's own name. */
const projectName = (path: string) => path.split("/").pop() ?? path;

export interface ReviewTarget {
  link: ProjectLink;
  /** The repository root, derived from the link and never from the request. */
  root: string;
}

/**
 * The repository a request is about, or null if it is not one of the
 * session's.
 *
 * Omitting `project` means the session's anchor, which is what a
 * single-project session means by "its" working copy — the same convention
 * `/api/sessions/[id]/git` uses.
 */
export async function resolveReviewTarget(
  sessionId: string,
  project?: string | null,
): Promise<ReviewTarget | null> {
  const links = await sessionProjects(sessionId);
  if (links.length === 0) return null;

  const link = project ? links.find((l) => l.path === project) : links[0];
  if (!link) return null;

  return { link, root: projectAbsolutePath(link) };
}

/**
 * A file inside a resolved repository, or null if the path escapes it.
 *
 * Two checks, not one: the project came from the session's allowlist above,
 * and the path is then contained with `relative` rather than a string prefix —
 * `/Dev` prefixes `/Devil`, and a check that accepts a sibling because its
 * name starts the same way is not a check.
 */
export function resolveReviewFile(
  target: ReviewTarget,
  relPath: string,
): string | null {
  if (!relPath) return null;
  return resolveInsideRoot(target.root, relPath);
}

/**
 * One of *this session's own* commits, by sha, or null.
 *
 * The narrowing matters. `readCommitFileDiff` refuses anything that is not a
 * 40-hex object name, which stops a revision expression, but any commit in the
 * repository's history is still a valid sha — and the panel's contract is
 * that a commit dot (or a summary-card chip) shows a commit *this session*
 * made. That used to be resolved through the current turn's `start..HEAD`
 * range, which is wrong for a sha from an earlier turn: `recordTurnStart`
 * moves the mark's start to HEAD every time a new prompt begins, so a
 * commit from turn 1 falls out of turn 2's range even though the session
 * genuinely made it — the range is a fact about *when this turn began*, not
 * about what the session has committed. Resolving straight from the
 * session's own commit log (`sessionCommitShasOrdered`) via
 * `readCommitsBySha` answers the question the panel actually asks: is this a
 * commit this session made, not is it inside the window the current turn
 * happens to be looking through.
 *
 * Null covers three cases that are all "no" to the caller: no commit
 * evidence for this project at all; a sha this session never committed here
 * (see review-session-commits.ts); and a sha the repository no longer has
 * (rebased away, gc'd), which `readCommitsBySha`'s `--ignore-missing` drops.
 */
export async function resolveSessionCommit(
  sessionId: string,
  target: ReviewTarget,
  sha: string,
): Promise<TurnCommit | null> {
  const shas = sessionCommitShasOrdered(sessionId, target.link.path);
  if (!shas || !shas.includes(sha)) return null;

  const commits = await readCommitsBySha(target.root, [sha]);
  return commits.find((commit) => commit.sha === sha) ?? null;
}

async function readProjectReview(
  link: ProjectLink,
  startSha: string | null,
  sessionId: string,
): Promise<ProjectReview> {
  const root = projectAbsolutePath(link);
  const sessionShas = sessionCommitShasOrdered(sessionId, link.path);

  const [{ files, omitted }, headSha, turnCommits] = await Promise.all([
    readChangedFiles(root),
    readHeadSha(root),
    // Every commit this session is on record as having made in this
    // project, across every turn — not `start..HEAD`. See
    // `resolveSessionCommit`'s doc for why the turn-scoped range undercounts
    // a session that spans more than one turn.
    readCommitsBySha(root, sessionShas ?? []),
  ]);

  return {
    changedFiles: files,
    headSha,
    name: projectName(link.path),
    omitted,
    otherActiveSessions: otherActiveSessionCount(link.path, sessionId),
    path: link.path,
    startSha,
    turnCommits,
  };
}

/**
 * Every project's review state, anchor first.
 *
 * Read in parallel: a session's projects are a handful, and each one is two
 * or three git subprocesses that have no reason to queue behind each other.
 */
export async function readSessionReview(
  sessionId: string,
): Promise<SessionReview> {
  const links = await sessionProjects(sessionId);
  const mark = readTurnMark(sessionId);

  const projects = await Promise.all(
    links.map((link) =>
      readProjectReview(
        link,
        mark?.projects[link.path]?.head ?? null,
        sessionId,
      ),
    ),
  );

  const digest = fingerprint(
    projects.map((project) => project.headSha ?? "none").join(","),
    projects.flatMap((project) => project.changedFiles),
  );

  // Changed *this turn*, which is not the same as dirty. Either the dirty set
  // moved since the prompt began, or the agent committed — and with no mark at
  // all nothing can be attributed to the turn, so nothing opens by itself.
  //
  // Compared against the mark's own `head`, not `project.turnCommits.length`:
  // `turnCommits` is now the session's *lifetime* commit list (see
  // `resolveSessionCommit`'s doc), so a session that committed in an earlier
  // turn would otherwise read as "changed this turn" forever after. HEAD
  // moving away from the mark's start already implies a commit happened
  // since, so `now !== start.state` alone (which folds in `headSha`) is the
  // whole test.
  const changedThisTurn = projects.some((project) => {
    const start = mark?.projects[project.path];
    if (!start) return false;
    const now = fingerprint(project.headSha, project.changedFiles);
    return now !== start.state;
  });

  return {
    changedThisTurn,
    fingerprint: digest,
    projects,
    reviewed: mark?.reviewed === digest,
  };
}

/**
 * Mark where each of the session's projects stood as a prompt begins.
 *
 * Called on the way into a turn, before the agent can change anything. It is
 * the only thing that lets the panel distinguish "the agent did this" from
 * "this tree was already dirty", so without it the feature degrades to a
 * manual review surface rather than misreporting: `changedThisTurn` is false
 * for a project with no mark, and nothing opens by itself.
 *
 * Best-effort by construction. Every failure inside `writeTurnMark` is
 * swallowed there, because a mark that cannot be written should cost the
 * auto-open and not the turn.
 */
export async function recordTurnStart(
  sessionId: string,
  turnId: string | null = null,
): Promise<void> {
  const links = await sessionProjects(sessionId);
  if (links.length === 0) return;

  const projects: Record<string, ProjectMark> = {};

  // Same two git reads artifact-snapshot.ts would otherwise pay again on the
  // first mutating tool call of the turn — seeding the cache here means the
  // chained "before" snapshot (see artifact-snapshot-cache.ts) is already in
  // place and that call costs zero extra subprocesses on the before side.
  await Promise.all(
    links.map(async (link) => {
      const root = projectAbsolutePath(link);
      const [{ files }, head] = await Promise.all([
        readChangedFiles(root),
        readHeadSha(root),
      ]);
      const state = fingerprint(head, files);
      projects[link.path] = { head, state };
      seedSnapshots(sessionId, [
        { at: new Date().toISOString(), files, head, projectPath: link.path, root, state },
      ]);
    }),
  );

  writeTurnMark(sessionId, {
    projects,
    // A new turn supersedes the last verdict: the operator dismissed a state
    // that no longer describes anything.
    reviewed: null,
    startedAt: new Date().toISOString(),
    turnId,
  });
}
