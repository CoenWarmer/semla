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

/**
 * Generous for a one-branch fetch, which is a couple of seconds even on a
 * large repository.
 */
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
 * The one thing worth fetching: the branch being compared against.
 *
 * Fetching a whole remote is not a slightly slower version of this, it is a
 * different order of magnitude. On elastic/kibana, `git fetch upstream main`
 * takes two seconds and `git fetch upstream --no-tags` takes five hundred and
 * twenty-four — every branch the project has ever pushed. The full fetch was
 * killed by the timeout on every attempt, so the tracking ref never moved and
 * the counts stayed wrong forever while looking authoritative.
 */
export function fetchArgs(remote: string, branch: string): string[] {
  return ["fetch", remote, branch, "--quiet", "--no-tags"];
}

/**
 * Fetch one branch of `remote` in the background unless one ran recently.
 *
 * Resolves as soon as the decision is made, not when the fetch finishes: the
 * caller is answering a request and must not wait on the network. Returns
 * whether a fetch is now running, so the client can poll faster until it lands.
 */
export function refreshRemote(
  path: string,
  remote: string,
  branch: string,
): boolean {
  if (GIT_FETCH_INTERVAL_MS <= 0) return false;
  if (inFlight.has(path)) return true;

  const previous = lastAttempt.get(path);
  if (previous !== undefined && Date.now() - previous < GIT_FETCH_INTERVAL_MS) {
    return false;
  }

  lastAttempt.set(path, Date.now());

  const run = (async () => {
    await git(path, fetchArgs(remote, branch), {
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

/**
 * Fetch now and wait for it, ignoring the throttle.
 *
 * For the moment somebody opens the popover: they have asked, explicitly, what
 * the state of this branch is, and are about to act on the answer. The poll's
 * once-a-minute ceiling is the wrong rule for a deliberate request, and
 * returning before the fetch lands would show them the very numbers they
 * opened it to escape.
 *
 * Still deduplicated — a background fetch already running is awaited rather
 * than raced with a second one.
 */
export async function fetchNow(
  path: string,
  remote: string,
  branch: string,
): Promise<void> {
  const running = inFlight.get(path);
  if (running) return running;

  lastAttempt.set(path, Date.now());

  const run = git(path, fetchArgs(remote, branch), {
    timeout: FETCH_TIMEOUT_MS,
    network: true,
  })
    .then(() => undefined)
    .catch(() => undefined)
    .finally(() => {
      inFlight.delete(path);
    });

  inFlight.set(path, run);
  return run;
}

/** Test seam: forget throttle and in-flight state. */
export function resetFetchStateForTests(): void {
  inFlight.clear();
  lastAttempt.clear();
}
