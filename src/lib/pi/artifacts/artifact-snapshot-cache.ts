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
