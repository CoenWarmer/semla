import { branchNameFromBase } from "@/lib/git-status-display";

import { fetchArgs } from "./git-fetch";
import { gitResult } from "./git";

/**
 * The two things the branch indicator lets you do to a working copy.
 *
 * Both write to the repository, so both are built to fail safely and say why.
 * Neither takes a ref from the client: the caller passes what the status read
 * already resolved, so a button press can only ever act on this session's own
 * project and its own canonical base.
 */

export interface GitActionResult {
  ok: boolean;
  message: string;
}

/**
 * The one line worth showing a user out of git's chatter.
 *
 * Not simply the first line: a conflicted merge opens with "Auto-merging
 * c.txt" and only names the conflict afterwards, so taking the top line
 * reports the step that worked instead of the one that did not.
 */
export function explainGitFailure(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("hint:"));

  return (
    lines.find((line) => line.includes("CONFLICT")) ??
    lines.find((line) => /^(error|fatal):/.test(line)) ??
    lines.find((line) => !line.startsWith("Auto-merging")) ??
    lines[0] ??
    "git failed"
  );
}

/** A fetch of one branch is seconds, but a cold or large one deserves room. */
const FETCH_TIMEOUT_MS = 120_000;

/**
 * Merge the canonical base into the current branch, fetching it first.
 *
 * The fetch is not optional and it is not in the background. `upstream/main`
 * is a local ref, and merging it without refreshing merges whatever this
 * machine last saw — which on kibana was a thousand commits behind while the
 * button cheerfully reported "Merged upstream/main." Waiting is the point:
 * this is `git fetch upstream main && git merge upstream/main`, in that order.
 *
 * A conflict is rolled back rather than left in the tree. A hover popup is too
 * casual an affordance to leave a repository mid-merge from — you would find
 * out later, somewhere else. `git merge --abort` restores the tree exactly, so
 * the button either lands a clean merge or changes nothing, and says which.
 */
export async function mergeIntoCurrent(
  path: string,
  base: string,
): Promise<GitActionResult> {
  const slash = base.indexOf("/");
  const remote = slash === -1 ? null : base.slice(0, slash);
  const branch = branchNameFromBase(base);

  // Offline is not a reason to refuse: the merge still does something useful
  // with the refs on disk. It is a reason to say the numbers may be old.
  let stale = "";
  if (remote && branch) {
    const fetched = await gitResult(path, fetchArgs(remote, branch), {
      timeout: FETCH_TIMEOUT_MS,
      network: true,
    });
    if (!fetched.ok) stale = ` Could not reach ${remote}, so this used the refs already on disk.`;
  }

  const merge = await gitResult(path, ["merge", "--no-edit", base], {
    timeout: 30_000,
  });

  if (merge.ok) {
    const alreadyCurrent = /already up to date/i.test(merge.stdout);
    return {
      ok: true,
      message:
        (alreadyCurrent ? `Already up to date with ${base}.` : `Merged ${base}.`) +
        stale,
    };
  }

  // Harmless when no merge was ever started — git just says there is none.
  const aborted = await gitResult(path, ["merge", "--abort"]);
  const reason = explainGitFailure(`${merge.stdout}\n${merge.stderr}`);

  return {
    ok: false,
    message: aborted.ok ? `${reason} Merge rolled back.` : reason,
  };
}

/** Switch to a local branch, leaving git to refuse if that would lose work. */
export async function checkoutBranch(
  path: string,
  branch: string,
): Promise<GitActionResult> {
  const result = await gitResult(path, ["checkout", branch]);
  return result.ok
    ? { ok: true, message: `Checked out ${branch}.` }
    : { ok: false, message: explainGitFailure(`${result.stdout}\n${result.stderr}`) };
}
