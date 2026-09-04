/**
 * Which other sessions are working in a project right now.
 *
 * Phase 1 of docs/plans/session-isolation.md: make concurrency *visible*
 * rather than mitigating it with a prompt rule. Nothing here blocks or
 * serialises anything — it only answers a question the harness could already
 * answer by combining two registries that already exist: `live-sessions.ts`
 * knows which sessions are actually running a turn, and each session's own
 * `ProjectLink[]` (on `SessionMeta`) knows which projects it works in.
 *
 * "Working in a project" means "linked to it and currently running a turn" —
 * not merely linked. A session that attached a project last week and has not
 * touched it since is not a concurrency risk; one running a turn against the
 * same project right now is.
 */

import { listSessionMeta, type SessionMeta } from "@/lib/pi/session-meta";
import { isSessionActive } from "@/lib/pi/session-service";

/**
 * Other sessions' ids, keyed by workspace-relative project path.
 *
 * `allSessions` is injectable so a caller that has already paid for
 * `listSessionMeta()` — the sidebar's whole-list route — does not read the
 * session directory a second time.
 */
export function otherActiveSessionsByProject(
  projectPaths: readonly string[],
  selfSessionId: string,
  allSessions: readonly SessionMeta[] = listSessionMeta(),
): Record<string, string[]> {
  const others = allSessions.filter(
    (meta) => meta.id !== selfSessionId && isSessionActive(meta.id),
  );

  const result: Record<string, string[]> = {};
  for (const path of projectPaths) {
    result[path] = others
      .filter((meta) => meta.projects.some((link) => link.path === path))
      .map((meta) => meta.id);
  }
  return result;
}

/** How many other sessions are active in a single project, right now. */
export function otherActiveSessionCount(
  projectPath: string,
  selfSessionId: string,
  allSessions: readonly SessionMeta[] = listSessionMeta(),
): number {
  return (
    otherActiveSessionsByProject([projectPath], selfSessionId, allSessions)[
      projectPath
    ]?.length ?? 0
  );
}
