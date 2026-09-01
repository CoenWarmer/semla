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

const repos = (): Map<string, string[]> =>
  readOrInitSlot(WIKI_SESSION_REPOS, () => new Map());

/**
 * Publish the repos a session's pages should be attributed to.
 *
 * A list, because a session can work in several. Called again as a turn
 * discovers more, so the set a captured page is tagged with is the one that was
 * true when it was captured rather than at the start of the turn.
 *
 * An empty list clears the entry instead of recording nothing, so a session
 * that loses its projects stops attributing pages to the ones it used to have.
 */
export function setSessionRepos(
  sessionId: string | undefined,
  slugs: readonly string[],
): void {
  if (!sessionId) return;

  const unique = [...new Set(slugs.filter(Boolean))];
  if (unique.length === 0) repos().delete(sessionId);
  else repos().set(sessionId, unique);
}

export function getSessionRepos(sessionId: string | undefined): string[] {
  if (!sessionId) return [];
  return repos().get(sessionId) ?? [];
}

/**
 * Drop a finished session's entry, so the map does not grow for the life of the
 * server and a reused id cannot inherit a stale repo.
 */
export function clearSessionRepo(sessionId: string | undefined): void {
  if (!sessionId) return;
  repos().delete(sessionId);
}
