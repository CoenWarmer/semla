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

/**
 * Merge the canonical base into the current branch.
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
  const merge = await gitResult(path, ["merge", "--no-edit", base], {
    timeout: 30_000,
  });

  if (merge.ok) {
    const alreadyCurrent = /already up to date/i.test(merge.stdout);
    return {
      ok: true,
      message: alreadyCurrent ? `Already up to date with ${base}.` : `Merged ${base}.`,
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
