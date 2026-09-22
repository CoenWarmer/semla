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

import { NextResponse } from "next/server";

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
 * Which of the two guards refused a request.
 *
 * Named rather than boolean because the two are not interchangeable to a
 * caller: `"project"` means the identifier is not one this session is linked
 * to, `"path"` means the project was fine and the path was not inside it.
 * Routes that word those the same way can ignore the distinction; the hunks
 * route deliberately does not ("Invalid path" against "Not a project this
 * session is linked to."), and a shared adapter that folded them together
 * would have quietly changed its responses.
 */
export type ReviewTargetFailure = "project" | "path";

/** What a refusal should be turned into, by reason. */
export type ReviewFailureResponder<T> = (reason: ReviewTargetFailure) => T;

interface ReviewTargetOptions<T> {
  /** The session the request is against — the allowlist the project is checked against. */
  sessionId: string;
  /** The caller's project identifier; omitted or null means the session's anchor. */
  project?: string | null;
  /** Built from the refusal reason, so no wording is baked into this module. */
  onFailure: ReviewFailureResponder<T>;
}

interface ReviewFileOptions<T> extends ReviewTargetOptions<T> {
  /**
   * The project-relative path to contain. `null` is itself a `"path"`
   * refusal, so a route may hand over whatever it parsed out of the request
   * without checking first — though most check earlier, because they have a
   * more specific thing to say about a missing path than about one that
   * escapes.
   */
  path: string | null;
}

/**
 * The guard preamble every review route was writing out by hand: resolve the
 * repository from the session's own links, then run the handler.
 *
 * It exists because nine routes had all independently re-derived the same two
 * lines, and two guards copied nine times are two guards that can drift. The
 * one in `resolveReviewTarget` is the only thing standing between a request
 * and an arbitrary repository, so it is worth having exactly one spelling of
 * the sequence and letting the routes differ only in what they say when it
 * refuses.
 *
 * Which is why the response is a parameter and not a constant here. The
 * routes genuinely disagree about the body — `{ message, ok: false }` for the
 * ones the panel treats as actions, `{ error }` for the ones it treats as
 * reads — and unifying that would have been an API change smuggled in under a
 * refactor. `messageFailure` and `errorFailure` below are the two shapes
 * spelled once; anything else can pass its own function.
 */
export async function withReviewTarget<T>(
  options: ReviewTargetOptions<T>,
  handler: (target: ReviewTarget) => T | Promise<T>,
): Promise<T> {
  const target = await resolveReviewTarget(options.sessionId, options.project ?? null);
  if (!target) return options.onFailure("project");

  return handler(target);
}

/**
 * The same preamble for a route that names a file: resolve the repository,
 * contain the path inside it, then run the handler.
 *
 * A separate function rather than an optional field on the one above so the
 * handler can be handed a `string` absolute path instead of `string | null`.
 * A path-taking route has nothing sensible to do with a null there, and the
 * check is the whole reason it called this.
 *
 * Order is load-bearing: the project is resolved first, because a containment
 * check needs a root to contain against, and a caller that words the two
 * refusals differently is reporting on the first thing that failed.
 */
export async function withReviewFile<T>(
  options: ReviewFileOptions<T>,
  handler: (target: ReviewTarget, absolutePath: string) => T | Promise<T>,
): Promise<T> {
  return withReviewTarget(options, (target) => {
    const absolute = options.path ? resolveReviewFile(target, options.path) : null;
    if (!absolute) return options.onFailure("path");

    return handler(target, absolute);
  });
}

/**
 * Wording for the two refusals. `path` defaults to `project`, because most
 * routes say one thing for both — a caller only spells it out when it has
 * something more specific to say about the path, as the hunks route does.
 */
export interface ReviewFailureWording {
  project: string;
  path?: string;
}

const wordingFor = (wording: ReviewFailureWording, reason: ReviewTargetFailure) =>
  reason === "path" ? (wording.path ?? wording.project) : wording.project;

/**
 * `{ message, ok: false }` at 400 — the shape the panel's action routes
 * (stage, commit, uncommit POST) already return, and which its client reads
 * `ok` off to decide whether anything happened.
 */
export const messageFailure =
  (wording: ReviewFailureWording): ReviewFailureResponder<NextResponse> =>
  (reason) =>
    NextResponse.json({ message: wordingFor(wording, reason), ok: false }, { status: 400 });

/**
 * `{ error }` at 400 — the shape the read routes return, where there is no
 * partial success to report and the body is only there to be shown.
 */
export const errorFailure =
  (wording: ReviewFailureWording): ReviewFailureResponder<NextResponse> =>
  (reason) =>
    NextResponse.json({ error: wordingFor(wording, reason) }, { status: 400 });

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
