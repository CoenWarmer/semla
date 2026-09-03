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

import { resolveInsideRoot } from "@/lib/pi/file-browser";
import {
  readChangedFiles,
  readHeadSha,
  readTurnCommits,
} from "@/lib/pi/review-status";
import {
  fingerprint,
  readTurnMark,
  writeTurnMark,
  type ProjectMark,
} from "@/lib/pi/review-turn-mark";
import { projectAbsolutePath, sessionProjects } from "@/lib/pi/session-project";
import type { ProjectLink } from "@/lib/pi/session-meta";
import type { ProjectReview, SessionReview } from "@/lib/review-types";

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

async function readProjectReview(
  link: ProjectLink,
  startSha: string | null,
): Promise<ProjectReview> {
  const root = projectAbsolutePath(link);
  const [{ files, omitted }, headSha] = await Promise.all([
    readChangedFiles(root),
    readHeadSha(root),
  ]);

  return {
    changedFiles: files,
    headSha,
    name: projectName(link.path),
    omitted,
    path: link.path,
    startSha,
    turnCommits: await readTurnCommits(root, startSha),
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
      readProjectReview(link, mark?.projects[link.path]?.head ?? null),
    ),
  );

  const digest = fingerprint(
    projects.map((project) => project.headSha ?? "none").join(","),
    projects.flatMap((project) => project.changedFiles),
  );

  // Changed *this turn*, which is not the same as dirty. Either the dirty set
  // moved since the prompt began, or the agent committed — and with no mark at
  // all nothing can be attributed to the turn, so nothing opens by itself.
  const changedThisTurn = projects.some((project) => {
    const start = mark?.projects[project.path];
    if (!start) return false;
    const now = fingerprint(project.headSha, project.changedFiles);
    return now !== start.state || project.turnCommits.length > 0;
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
export async function recordTurnStart(sessionId: string): Promise<void> {
  const links = await sessionProjects(sessionId);
  if (links.length === 0) return;

  const projects: Record<string, ProjectMark> = {};

  await Promise.all(
    links.map(async (link) => {
      const root = projectAbsolutePath(link);
      const [{ files }, head] = await Promise.all([
        readChangedFiles(root),
        readHeadSha(root),
      ]);
      projects[link.path] = { head, state: fingerprint(head, files) };
    }),
  );

  writeTurnMark(sessionId, {
    projects,
    // A new turn supersedes the last verdict: the operator dismissed a state
    // that no longer describes anything.
    reviewed: null,
    startedAt: new Date().toISOString(),
  });
}
