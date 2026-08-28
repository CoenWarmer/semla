/**
 * Which repo a pi session is orienting, keyed by session id.
 *
 * A tool's execute context carries only `cwd`, which every session shares, so a
 * tool cannot work out which session invoked it. The wiki bridge learns its own
 * session id at `session_start` and reads the repo from here.
 *
 * Keyed rather than a single "current repo" value because concurrent orient
 * sessions live in one process: one value would be whichever session started
 * last, which is the misattribution this exists to prevent.
 *
 * Server-side half of the pair. The bridge reads the same globalThis slot
 * directly, because it is loaded by jiti and cannot resolve the `@/` alias this
 * module uses — the same split as workflow-manager-registry.ts.
 */

import {
  readOrInitSlot,
  WIKI_SESSION_REPOS,
} from "@/lib/pi/extension-contract";

const repos = (): Map<string, string> =>
  readOrInitSlot(WIKI_SESSION_REPOS, () => new Map());

/** Publish the repo a session is working in. No slug means nothing to record. */
export function setSessionRepo(
  sessionId: string | undefined,
  repo: string | null,
): void {
  if (!sessionId || !repo) return;
  repos().set(sessionId, repo);
}

export function getSessionRepo(sessionId: string | undefined): string | null {
  if (!sessionId) return null;
  return repos().get(sessionId) ?? null;
}

/**
 * Drop a finished session's entry, so the map does not grow for the life of the
 * server and a reused id cannot inherit a stale repo.
 */
export function clearSessionRepo(sessionId: string | undefined): void {
  if (!sessionId) return;
  repos().delete(sessionId);
}
