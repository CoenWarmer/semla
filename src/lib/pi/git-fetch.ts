import { stat } from "node:fs/promises";
import { join } from "node:path";

import { GIT_FETCH_INTERVAL_MS } from "./runtime-config";
import { git } from "./git";

/**
 * Keeping remote refs fresh, so divergence counts mean something.
 *
 * Reading alone reports where you stood at the last fetch, which can be badly
 * wrong: catalog-info read "up to date" while actually sitting 432 commits
 * behind the canonical main, because nothing had fetched in days.
 *
 * Fetching is a network call with side effects, so it never happens on the
 * request path. A read kicks one off in the background at most once per
 * interval, and the next poll sees the newer refs.
 */

/** A fetch can be slow on a large repo — catalog-info takes over five seconds. */
const FETCH_TIMEOUT_MS = 30_000;

/** In-flight fetches, keyed by repo, so concurrent readers share one. */
const inFlight = new Map<string, Promise<void>>();

/** When we last *started* a fetch, to throttle even if it failed. */
const lastAttempt = new Map<string, number>();

/**
 * When this repository last fetched, from the mtime of `.git/FETCH_HEAD`.
 *
 * Read off disk rather than remembered in memory so it survives a server
 * restart and counts fetches made in a terminal — the question is when these
 * refs were last true, not when Semla last did something.
 */
export async function lastFetchedAt(path: string): Promise<number | null> {
  try {
    const info = await stat(join(path, ".git", "FETCH_HEAD"));
    return info.mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Fetch `remote` in the background unless one ran recently.
 *
 * Resolves as soon as the decision is made, not when the fetch finishes: the
 * caller is answering a request and must not wait on the network. Returns
 * whether a fetch is now running, so the client can poll faster until it lands.
 */
export function refreshRemote(path: string, remote: string): boolean {
  if (GIT_FETCH_INTERVAL_MS <= 0) return false;
  if (inFlight.has(path)) return true;

  const previous = lastAttempt.get(path);
  if (previous !== undefined && Date.now() - previous < GIT_FETCH_INTERVAL_MS) {
    return false;
  }

  lastAttempt.set(path, Date.now());

  const run = (async () => {
    // --no-tags keeps a busy remote's tag history out of a poll-driven fetch;
    // the comparison only needs branch refs.
    await git(path, ["fetch", remote, "--quiet", "--no-tags"], {
      timeout: FETCH_TIMEOUT_MS,
      network: true,
    });
  })()
    .catch(() => {
      // Offline, no credentials, remote gone. The badge keeps reporting local
      // refs and the fetch age tells the user they are old; nothing to raise.
    })
    .finally(() => {
      inFlight.delete(path);
    });

  inFlight.set(path, run);
  return true;
}

/** Test seam: forget throttle and in-flight state. */
export function resetFetchStateForTests(): void {
  inFlight.clear();
  lastAttempt.clear();
}
