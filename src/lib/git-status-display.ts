/**
 * Shape and presentation of a working copy's branch state.
 *
 * Deliberately free of node imports: this is read by a client component, and
 * the reader that produces it (src/lib/pi/git-status.ts) shells out to git.
 * See client-boundary.test.ts for why that separation is load-bearing.
 */

export interface GitStatus {
  /** Current branch, or null when HEAD is detached. */
  branch: string | null;
  /** Short HEAD sha. The only identity a detached HEAD has. */
  head: string | null;
  /**
   * What ahead/behind compare against: the canonical repository's default
   * branch, so "upstream/main" on a fork and "origin/main" otherwise.
   */
  base: string | null;
  ahead: number | null;
  behind: number | null;
  /** When the remote refs were last fetched, epoch ms, or null if never. */
  fetchedAt: number | null;
  /** A fetch is running now, so these counts are about to be replaced. */
  fetching: boolean;
}

export const EMPTY_GIT_STATUS: GitStatus = {
  branch: null,
  head: null,
  base: null,
  ahead: null,
  behind: null,
  fetchedAt: null,
  fetching: false,
};

/**
 * The local branch a remote base corresponds to: "upstream/main" → "main".
 *
 * Only the first segment is dropped. A base of "origin/release/2.x" names the
 * branch "release/2.x", so splitting on every slash would be wrong.
 */
export function branchNameFromBase(base: string | null): string | null {
  if (!base) return null;
  const slash = base.indexOf("/");
  return slash === -1 ? base : base.slice(slash + 1) || null;
}

/** Compact age for the tooltip: "just now", "4m ago", "2h ago". */
export function formatFetchAge(
  fetchedAt: number | null,
  now: number = Date.now(),
): string {
  if (fetchedAt === null) return "never fetched";
  const seconds = Math.max(0, Math.floor((now - fetchedAt) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export interface GitStatusLabel {
  /** Branch name, or a short sha when HEAD is detached. */
  ref: string;
  /** Commits on HEAD that the base lacks. Omitted when zero or unknown. */
  ahead: number | null;
  /** Commits on the base that HEAD lacks. Omitted when zero or unknown. */
  behind: number | null;
  /** Full sentence for the tooltip. */
  title: string;
}

const plural = (n: number) => (n === 1 ? "commit" : "commits");

/**
 * Reduce a status to what the toolbar shows, or null when there is nothing
 * worth showing — no project, or not a git repository.
 */
export function describeGitStatus(
  status: GitStatus | undefined | null,
): GitStatusLabel | null {
  if (!status?.head) return null;

  const ref = status.branch ?? status.head;
  const detached = !status.branch;

  if (!status.base) {
    return {
      ref,
      ahead: null,
      behind: null,
      title: detached
        ? `Detached at ${status.head}`
        : `On ${ref}, with no canonical branch to compare against`,
    };
  }

  const ahead = status.ahead ?? 0;
  const behind = status.behind ?? 0;

  // Name when these refs were last true. The caveat used to be a vague "as of
  // the last fetch"; now that Semla fetches, the honest thing is the actual age.
  const divergence =
    ahead === 0 && behind === 0
      ? `up to date with ${status.base}`
      : [
          ahead > 0 ? `${ahead} ${plural(ahead)} ahead of` : null,
          behind > 0 ? `${behind} ${plural(behind)} behind` : null,
        ]
          .filter(Boolean)
          .join(" and ") + ` ${status.base}`;

  return {
    ref,
    ahead: ahead > 0 ? ahead : null,
    behind: behind > 0 ? behind : null,
    title:
      `${detached ? `Detached at ${status.head}` : `On ${ref}`}, ` +
      `${divergence}. ` +
      (status.fetching
        ? "Fetching now…"
        : status.fetchedAt === null
          ? "Never fetched."
          : `Fetched ${formatFetchAge(status.fetchedAt)}.`),
  };
}
