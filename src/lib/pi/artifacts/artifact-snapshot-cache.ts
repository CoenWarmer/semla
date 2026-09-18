/**
 * The chained "before" snapshot for artifact capture.
 *
 * The design this exists for: a "before" snapshot is never read at tool
 * start. It is the cached "after" snapshot of the previous mutating call in
 * the same session+project, or — for the first call of a turn — the snapshot
 * `recordTurnStart` already took (seeded here so no extra git call is paid).
 * Only on a cache miss does artifact-capture.ts do a fresh read, and that read
 * happens at tool *end*, honestly labelled as producing no artifact for this
 * call (nothing to compare against yet) while still seeding the next one.
 *
 * Reading a "before" snapshot at tool start would be a race: launching `git
 * status` costs 10–30ms and a `bash` call can finish faster, so the "before"
 * would already include the change. Chaining removes the race and the cost.
 *
 * Module-level and keyed by sessionId so two sessions never see each other's
 * snapshots — the same isolation the review turn mark gives per session.
 */

import type { ProjectSnapshot } from "@/lib/pi/artifacts/artifact-snapshot";

const sessions = new Map<string, Map<string, ProjectSnapshot>>();

function sessionMap(sessionId: string): Map<string, ProjectSnapshot> {
  let existing = sessions.get(sessionId);
  if (!existing) {
    existing = new Map();
    sessions.set(sessionId, existing);
  }
  return existing;
}

/** Seed one or more snapshots, e.g. from recordTurnStart's own git reads. */
export function seedSnapshots(
  sessionId: string,
  snapshots: readonly ProjectSnapshot[],
): void {
  const map = sessionMap(sessionId);
  for (const snapshot of snapshots) map.set(snapshot.projectPath, snapshot);
}

export function getSnapshot(
  sessionId: string,
  projectPath: string,
): ProjectSnapshot | undefined {
  return sessions.get(sessionId)?.get(projectPath);
}

export function putSnapshot(sessionId: string, snapshot: ProjectSnapshot): void {
  sessionMap(sessionId).set(snapshot.projectPath, snapshot);
}

/** Drop everything cached for a session — called once its turn residual is captured. */
export function clearSession(sessionId: string): void {
  sessions.delete(sessionId);
}

/**
 * Which commit shas have already been attributed to *some* session, kept
 * project-scoped rather than session-scoped — the one piece of state in this
 * module that must outlive any single session's map.
 *
 * Why this exists: `before.head..after.head` in captureArtifacts is a fact
 * about the *repository*, not about whichever session's chained snapshot
 * happens to notice HEAD moved next. A commit made through the review panel's
 * commit route is not a tool call and captures nothing on its own, so without
 * a claim it sits unattributed until some session's own tool-call or
 * turn-residual capture stumbles on the moved HEAD — and that can be a
 * session that did nothing at all, purely because its cached snapshot for
 * this project happened to be read second. Two sessions racing to notice the
 * same real commit is the same failure with no review-panel commit involved.
 *
 * First claim wins, across every session, and a claim is never released — a
 * commit sha does not become un-committed.
 */
const claimedCommits = new Map<string, Set<string>>();

function claimedShasFor(projectPath: string): Set<string> {
  let existing = claimedCommits.get(projectPath);
  if (!existing) {
    existing = new Set();
    claimedCommits.set(projectPath, existing);
  }
  return existing;
}

/**
 * Claim shas for a project on behalf of whichever caller asks first.
 *
 * Returns only the subset newly claimed by *this* call — a sha some earlier
 * call (this session's own, or another session's) already claimed is
 * dropped, so at most one `CommitArtifact` is ever produced for a given sha
 * in a given project, no matter how many sessions' captures see it.
 */
export function claimCommits(
  projectPath: string,
  shas: readonly string[],
): string[] {
  const claimed = claimedShasFor(projectPath);
  const won: string[] = [];
  for (const sha of shas) {
    if (claimed.has(sha)) continue;
    claimed.add(sha);
    won.push(sha);
  }
  return won;
}

/**
 * Test-only: drop every claim. `claimedCommits` is deliberately global rather
 * than per-session — that is the whole point of it — so it is the one piece
 * of state in this module a test suite must reset itself rather than getting
 * isolation for free the way a fresh session id gives it elsewhere.
 */
export function clearAllClaims(): void {
  claimedCommits.clear();
}
