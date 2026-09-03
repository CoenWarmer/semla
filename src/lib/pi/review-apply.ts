/**
 * Staging what the operator chose, and committing it as their own commit.
 *
 * The commit is the point of the whole surface: the agent leaves changes, a
 * person reads them, and the person commits. So nothing here adds a trailer,
 * an author override, or a co-author — the commit is made with the
 * repository's own configured identity, which is the operator's, and it should
 * be indistinguishable from one they made by hand.
 *
 * `--only` is deliberately not used. The panel stages explicitly, hunk by
 * hunk, and then commits what is staged; `git commit --only -- paths` would
 * quietly re-stage whole files and undo the operator's hunk selection.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { explainGitFailure, type GitActionResult } from "@/lib/pi/git-actions";
import { git, gitInput, gitRaw, gitResult } from "@/lib/pi/git";
import { parsePorcelain } from "@/lib/pi/review-status";

/** Applying a patch is fast; a very large one still deserves room. */
const APPLY_TIMEOUT_MS = 30_000;

const ok = (message = ""): GitActionResult => ({ message, ok: true });
const failed = (message: string): GitActionResult => ({ message, ok: false });

/**
 * Refuse while another git process holds the index.
 *
 * A concurrent `git` — the agent's own, a terminal, an editor's integration —
 * makes every write here a race whose loser is silently discarded. git would
 * report its own lock error, but checking first lets the panel say something
 * an operator can act on.
 */
function indexLocked(root: string): boolean {
  return existsSync(join(root, ".git", "index.lock"));
}

/** Paths git considers conflicted. */
export async function unmergedPaths(root: string): Promise<string[]> {
  const output = await gitRaw(
    root,
    ["status", "--porcelain=v1", "-z", "--untracked-files=no"],
    { timeout: APPLY_TIMEOUT_MS },
  );

  if (!output) return [];
  return parsePorcelain(output)
    .filter((file) => file.status === "unmerged")
    .map((file) => file.path);
}

async function applyPatch(
  root: string,
  patch: string,
  reverse: boolean,
): Promise<GitActionResult> {
  if (indexLocked(root)) {
    return failed("Another git process is using this repository. Try again.");
  }

  const args = ["apply", "--cached", "--unidiff-zero"];
  if (reverse) args.push("--reverse");
  args.push("-");

  const result = await gitInput(root, args, patch, {
    timeout: APPLY_TIMEOUT_MS,
  });

  return result.ok
    ? ok()
    : failed(explainGitFailure(`${result.stderr}\n${result.stdout}`));
}

/**
 * Stage the hunks in `patch`.
 *
 * `--unidiff-zero` is passed even though hunks are read with three lines of
 * context. It costs nothing here and its absence, if the context width ever
 * changes, shows up as a patch git silently declines.
 */
export const stageHunks = (root: string, patch: string) =>
  applyPatch(root, patch, false);

/** Take the hunks in `patch` back out of the index. */
export const unstageHunks = (root: string, patch: string) =>
  applyPatch(root, patch, true);

/**
 * Stage a whole file.
 *
 * The answer for an untracked file, which has no index entry and therefore no
 * hunks to choose between: staging it means adding it. `--` separates the path
 * from anything git might read as an option.
 */
export async function stageWholeFile(
  root: string,
  relPath: string,
): Promise<GitActionResult> {
  if (indexLocked(root)) {
    return failed("Another git process is using this repository. Try again.");
  }

  const result = await gitResult(root, ["add", "--", relPath], {
    timeout: APPLY_TIMEOUT_MS,
  });
  return result.ok ? ok() : failed(explainGitFailure(result.stderr));
}

/**
 * Take a whole file back out of the index, leaving the working tree alone.
 *
 * `git restore --staged` rather than `git reset`: reset with a path is the
 * same operation but the command is also spelled `git reset --hard`, and a
 * typo away from destroying the operator's work.
 */
export async function unstageWholeFile(
  root: string,
  relPath: string,
): Promise<GitActionResult> {
  if (indexLocked(root)) {
    return failed("Another git process is using this repository. Try again.");
  }

  const result = await gitResult(root, ["restore", "--staged", "--", relPath], {
    timeout: APPLY_TIMEOUT_MS,
  });
  return result.ok ? ok() : failed(explainGitFailure(result.stderr));
}

/** Anything at all in the index that a commit would include. */
export async function hasStagedChanges(root: string): Promise<boolean> {
  // --quiet exits 1 when there is a difference, which is the answer wanted.
  const result = await gitResult(root, [
    "diff",
    "--cached",
    "--quiet",
    "--no-ext-diff",
  ]);
  return !result.ok;
}

/**
 * Commit what is staged, as the operator.
 *
 * Hooks are not skipped. A repository with a pre-commit hook has one for a
 * reason, and a review surface that quietly bypassed it would be committing
 * something the project's own rules reject — the failure is surfaced instead.
 */
export async function commitStaged(
  root: string,
  message: string,
): Promise<GitActionResult & { sha?: string }> {
  const subject = message.trim();
  if (!subject) return failed("A commit needs a message.");

  if (indexLocked(root)) {
    return failed("Another git process is using this repository. Try again.");
  }

  const conflicts = await unmergedPaths(root);
  if (conflicts.length > 0) {
    return failed(
      `Resolve the conflict in ${conflicts[0]} before committing.`,
    );
  }

  if (!(await hasStagedChanges(root))) {
    return failed("Nothing is staged. Choose some hunks first.");
  }

  const result = await gitResult(root, ["commit", "-m", subject], {
    timeout: APPLY_TIMEOUT_MS,
  });

  if (!result.ok) {
    return failed(explainGitFailure(`${result.stderr}\n${result.stdout}`));
  }

  const sha = await git(root, ["rev-parse", "HEAD"]);
  return { message: "", ok: true, sha: sha ?? undefined };
}
