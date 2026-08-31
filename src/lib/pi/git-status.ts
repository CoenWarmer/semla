import {
  EMPTY_GIT_STATUS,
  branchNameFromBase,
  type GitStatus,
} from "@/lib/git-status-display";

import { lastFetchedAt, refreshRemote } from "./git-fetch";
import { git } from "./git";

/**
 * Reads where a working copy sits relative to the branch it tracks.
 *
 * `ahead`/`behind` are measured against the last-fetched remote ref. Nothing
 * here runs `git fetch`: that is a network call with side effects, and firing
 * one off a UI poll would be wrong. So `behind` means "behind what this
 * machine last fetched", which is what `git status` reports too.
 */
export { EMPTY_GIT_STATUS, type GitStatus };

/**
 * Parse `git rev-list --left-right --count base...HEAD`, which prints the two
 * counts tab-separated with the left side — the base — first.
 */
export function parseAheadBehind(
  output: string | null,
): { ahead: number; behind: number } | null {
  if (!output) return null;
  const [left, right] = output.trim().split(/\s+/);
  const behind = Number(left);
  const ahead = Number(right);
  if (!Number.isInteger(behind) || !Number.isInteger(ahead)) return null;
  return { ahead, behind };
}

/**
 * Turn `git symbolic-ref refs/remotes/<remote>/HEAD` into a comparable ref.
 */
export function parseRemoteHead(output: string | null): string | null {
  if (!output) return null;
  const match = output.trim().match(/^refs\/remotes\/(.+)$/);
  return match ? match[1] : null;
}

/**
 * Choose the remote that represents the canonical repository.
 *
 * Under the usual fork workflow `origin` is your own fork and `upstream` is
 * the repository it was forked from, so `upstream` wins where it exists. This
 * is the difference between a useful number and a meaningless one: a fork
 * whose default branch is simply never pushed to reported 922 commits ahead of
 * `origin/main` while being exactly level with the canonical `upstream/main`.
 *
 * Note the collision in git's own vocabulary — this is a *remote* named
 * "upstream", not a branch's `@{upstream}` tracking ref. They are unrelated,
 * and on a fork they point at different repositories.
 */
export function pickCanonicalRemote(remotes: string[]): string | null {
  if (remotes.includes("upstream")) return "upstream";
  if (remotes.includes("origin")) return "origin";
  return remotes[0] ?? null;
}

/**
 * The ref to measure against on a given remote: its recorded default branch,
 * falling back to the conventional names.
 *
 * `git clone` records HEAD for `origin`, but a remote added by hand — which is
 * how an `upstream` normally arrives — has none until someone runs
 * `git remote set-head`, so the fallbacks are the common case, not the edge.
 */
async function remoteDefaultRef(
  path: string,
  remote: string,
): Promise<string | null> {
  const recorded = parseRemoteHead(
    await git(path, ["symbolic-ref", `refs/remotes/${remote}/HEAD`]),
  );
  if (recorded) return recorded;

  for (const candidate of [`${remote}/main`, `${remote}/master`]) {
    if (await git(path, ["rev-parse", "--verify", "--quiet", candidate])) {
      return candidate;
    }
  }
  return null;
}

/**
 * Read branch and divergence for a working copy.
 *
 * Divergence is measured against the canonical repository's default branch —
 * `upstream/main` on a fork, `origin/main` otherwise — because that is the
 * mainline the work will eventually land on. It is deliberately not the
 * branch's own `@{upstream}`: on a fork that is your own copy, and how far you
 * have drifted from your own fork answers nothing anybody asked. The tracking
 * branch is kept only as a last resort, for a repository whose remotes cannot
 * be read at all.
 */
export interface ReadGitStatusOptions {
  /**
   * Whether a read may start a background fetch.
   *
   * On for a single repository the user is looking at. Off when reading the
   * whole workspace: forty-two repositories would mean forty-two network
   * fetches every time the home page polled, which is not a thing to do to
   * somebody's connection for a set of numbers on a card.
   */
  fetch?: boolean;
}

export async function readGitStatus(
  path: string,
  { fetch = true }: ReadGitStatusOptions = {},
): Promise<GitStatus> {
  const [branch, head] = await Promise.all([
    git(path, ["branch", "--show-current"]),
    git(path, ["rev-parse", "--short", "HEAD"]),
  ]);

  if (!head) return EMPTY_GIT_STATUS;

  const remotes = (await git(path, ["remote"]))?.split("\n").map((r) => r.trim()) ?? [];
  const canonical = pickCanonicalRemote(remotes.filter(Boolean));

  const base =
    (canonical ? await remoteDefaultRef(path, canonical) : null) ??
    (await git(path, [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    ]));

  // Kick off a fetch for next time. This returns immediately — the counts
  // below still come from the refs already on disk, and the caller polls again
  // once `fetching` clears. It has to come after the base is known: only one
  // branch is fetched, and this is where its name comes from.
  const baseBranch = branchNameFromBase(base);
  const fetching =
    fetch && canonical && baseBranch
      ? refreshRemote(path, canonical, baseBranch)
      : false;

  const fetchedAt = await lastFetchedAt(path);

  if (!base) {
    return { branch, head, base: null, ahead: null, behind: null, fetchedAt, fetching };
  }

  const counts = parseAheadBehind(
    await git(path, ["rev-list", "--left-right", "--count", `${base}...HEAD`]),
  );

  return {
    branch,
    head,
    base,
    ahead: counts?.ahead ?? null,
    behind: counts?.behind ?? null,
    fetchedAt,
    fetching,
  };
}
