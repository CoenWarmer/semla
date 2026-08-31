import { EMPTY_GIT_STATUS, type GitStatus } from "@/lib/git-status-display";

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
 * Turn `git symbolic-ref refs/remotes/origin/HEAD` into a comparable ref.
 * Used only when the branch tracks nothing of its own.
 */
export function parseRemoteHead(output: string | null): string | null {
  if (!output) return null;
  const match = output.trim().match(/^refs\/remotes\/(.+)$/);
  return match ? match[1] : null;
}

/**
 * Read branch and divergence for a working copy.
 *
 * The comparison base is the branch's own upstream when it has one. An
 * unpublished branch has no upstream, so it falls back to the remote's default
 * branch — otherwise a new branch would show nothing at all, when "how far off
 * mainline am I" is exactly what you want to know there.
 */
export async function readGitStatus(path: string): Promise<GitStatus> {
  const [branch, head] = await Promise.all([
    git(path, ["branch", "--show-current"]),
    git(path, ["rev-parse", "--short", "HEAD"]),
  ]);

  if (!head) return EMPTY_GIT_STATUS;

  const base =
    (await git(path, [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    ])) ??
    parseRemoteHead(
      await git(path, ["symbolic-ref", "refs/remotes/origin/HEAD"]),
    );

  if (!base) return { branch, head, base: null, ahead: null, behind: null };

  const counts = parseAheadBehind(
    await git(path, ["rev-list", "--left-right", "--count", `${base}...HEAD`]),
  );

  return {
    branch,
    head,
    base,
    ahead: counts?.ahead ?? null,
    behind: counts?.behind ?? null,
  };
}
