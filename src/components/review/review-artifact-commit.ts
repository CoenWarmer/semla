/**
 * Which commit `ReviewCommitNav` should have selected.
 *
 * The same precedence rule as `activeRequest` in review-panel-request.ts,
 * applied to one more piece of state that a target can drive: a commit
 * artifact chip names a `commitSha`, and once the operator picks a different
 * commit by hand — or clears the selection — that choice must win until a
 * *newer* target arrives, without an effect syncing anything.
 *
 * `overNonce` is stamped the same way `revise()` stamps it on `PanelRequest`:
 * every self-made selection records which external target was in force when
 * it was made, so a target with a newer nonce overrides it automatically.
 */

export interface OwnCommitSelection {
  sha: string | null;
  overNonce: number;
}

export const BLANK_COMMIT_SELECTION: OwnCommitSelection = {
  overNonce: 0,
  sha: null,
};

interface CommitTarget {
  commitSha?: string | null;
  nonce: number;
}

/**
 * The selected commit sha, or null when nothing is selected.
 *
 * Mirrors `activeRequest`: the operator's own selection applies only while
 * its `overNonce` still matches the current target's nonce; a target with a
 * newer nonce overrides it, whether or not that target names a commit at all
 * — a target with no `commitSha` is "clear the selection", not "leave it".
 */
export function activeCommitSha(
  own: OwnCommitSelection,
  target: CommitTarget | null | undefined,
): string | null {
  const nonce = target?.nonce ?? 0;
  if (own.overNonce === nonce) return own.sha;
  return target?.commitSha ?? null;
}
