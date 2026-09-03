/**
 * Bringing the agent's own commits back into the working tree, so they can be
 * reviewed like everything else.
 *
 * Nothing stops the agent committing: it has `bash`, and the system prompt says
 * nothing about git. Forbidding it in the prompt was considered and rejected —
 * a prompt rule is a request, and a model that commits anyway produces exactly
 * the silent gap the rule was meant to close. Reading `git log` cannot be
 * disobeyed, so the panel reads it, and this is how the operator acts on it.
 *
 * `git reset --mixed` is the only destructive operation in the review feature.
 * Every check below refuses rather than proceeds, and the reset is a two-step:
 * `planReset` says what would happen and `performReset` will only do it when
 * handed back the target it was shown. That echo is what stops a stale panel
 * resetting to a sha that has since stopped meaning anything.
 *
 * `--mixed` rather than `--soft`: soft leaves the changes staged, which
 * pre-empts the hunk selection the rest of the panel is built around. Mixed
 * puts them in the working tree as unstaged edits — the state every other part
 * of this feature already understands.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { explainGitFailure, type GitActionResult } from "@/lib/pi/git-actions";
import { git, gitResult } from "@/lib/pi/git";
import { readTurnCommits } from "@/lib/pi/review-status";
import type { TurnCommit } from "@/lib/review-types";

export interface ResetPlan {
  /** The reset is allowed. When false, `message` says why not. */
  allowed: boolean;
  message: string;
  /** What would come back, newest first. */
  commits: TurnCommit[];
  /** The sha the reset would move to. Echoed back to perform it. */
  target: string | null;
  /**
   * Commits in the range that already exist on the tracking branch.
   * Non-zero is a refusal: resetting a pushed commit rewrites shared history,
   * and this panel is not the place to authorise that.
   */
  pushed: number;
  /**
   * Uncommitted changes are present as well as commits. Not a refusal — it is
   * the normal state after a turn that both edited and committed — but the
   * operator is told, because the reset mixes the two sets together.
   */
  dirty: boolean;
}

const refuse = (message: string): ResetPlan => ({
  allowed: false,
  commits: [],
  dirty: false,
  message,
  pushed: 0,
  target: null,
});

/** The repository's git directory, which is not always `.git`. */
async function gitDir(root: string): Promise<string> {
  const dir = await git(root, ["rev-parse", "--git-dir"]);
  if (!dir) return join(root, ".git");
  return dir.startsWith("/") ? dir : join(root, dir);
}

/**
 * An operation git is in the middle of, or null.
 *
 * A reset during a merge or a rebase discards state git is relying on to
 * finish, and the result is a repository whose next command reports something
 * unrelated to what the operator did.
 */
async function interruptedBy(root: string): Promise<string | null> {
  const dir = await gitDir(root);

  if (existsSync(join(dir, "index.lock"))) {
    return "another git process is using this repository";
  }
  if (existsSync(join(dir, "MERGE_HEAD"))) return "a merge is in progress";
  if (
    existsSync(join(dir, "rebase-merge")) ||
    existsSync(join(dir, "rebase-apply"))
  ) {
    return "a rebase is in progress";
  }
  if (existsSync(join(dir, "CHERRY_PICK_HEAD"))) {
    return "a cherry-pick is in progress";
  }
  return null;
}

/** How many commits in the range are already on the tracking branch. */
async function countPushed(root: string, startSha: string): Promise<number> {
  const upstream = await git(root, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{upstream}",
  ]);
  // No tracking branch: nothing has been shared, so nothing can be rewritten.
  if (!upstream) return 0;

  const total = await git(root, ["rev-list", "--count", `${startSha}..HEAD`]);
  const unpushed = await git(root, [
    "rev-list",
    "--count",
    `${startSha}..HEAD`,
    `^${upstream}`,
  ]);

  if (total === null || unpushed === null) return 0;
  return Math.max(0, Number(total) - Number(unpushed));
}

/**
 * Whether a reset is allowed, and what it would do.
 *
 * Read-only. Every refusal is returned rather than thrown so the panel can
 * show the reason next to the disabled button instead of an error toast with
 * no context.
 */
export async function planReset(
  root: string,
  startSha: string | null,
): Promise<ResetPlan> {
  if (!startSha) {
    return refuse(
      "Semla did not record where this turn began, so there is no range to " +
        "bring back.",
    );
  }

  const interrupted = await interruptedBy(root);
  if (interrupted) {
    return refuse(`Cannot reset while ${interrupted}.`);
  }

  // A detached HEAD has no branch to move, and resetting one is how work
  // becomes reachable only through the reflog.
  const branch = await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!branch) {
    return refuse("HEAD is detached. Check out a branch first.");
  }

  // The same ancestry check readTurnCommits makes, for the same reason: a
  // branch rebased or reset since the turn began makes `start..HEAD` describe
  // a different set of commits entirely.
  const ancestor = await gitResult(root, [
    "merge-base",
    "--is-ancestor",
    startSha,
    "HEAD",
  ]);
  if (!ancestor.ok) {
    return refuse(
      "This branch has moved since the turn began, so the commits recorded " +
        "for it can no longer be identified.",
    );
  }

  const commits = await readTurnCommits(root, startSha);
  if (commits.length === 0) {
    return refuse("The agent made no commits in this turn.");
  }

  const pushed = await countPushed(root, startSha);
  if (pushed > 0) {
    return {
      allowed: false,
      commits,
      dirty: false,
      message:
        `${pushed} of these commits ${pushed === 1 ? "is" : "are"} already on ` +
        "the tracking branch. Undoing them here would rewrite history other " +
        "checkouts have, which needs a decision this panel will not make for " +
        "you.",
      pushed,
      target: startSha,
    };
  }

  const dirty = Boolean(await git(root, ["status", "--porcelain=v1"]));

  return {
    allowed: true,
    commits,
    dirty,
    message: "",
    pushed: 0,
    target: startSha,
  };
}

/**
 * Move the branch back to `target`, leaving everything in the working tree.
 *
 * `expected` is the target the operator was shown. It has to match, because
 * the panel may have been open across another turn and the plan it is acting
 * on may describe a range that no longer exists.
 *
 * The plan is re-derived here rather than trusted from the caller: this is the
 * write, and the checks are only worth anything if they run against the
 * repository as it is now.
 */
export async function performReset(
  root: string,
  startSha: string | null,
  expected: string,
): Promise<GitActionResult> {
  const plan = await planReset(root, startSha);

  if (!plan.allowed) return { message: plan.message, ok: false };
  if (plan.target !== expected) {
    return {
      message:
        "This repository has moved since the panel read it. Reload the " +
        "review before undoing anything.",
      ok: false,
    };
  }

  const result = await gitResult(root, ["reset", "--mixed", expected]);
  if (!result.ok) {
    return { message: explainGitFailure(result.stderr), ok: false };
  }

  const count = plan.commits.length;
  return {
    message:
      `${count} commit${count === 1 ? "" : "s"} moved back into the working ` +
      "tree. Nothing was lost — `git reflog` still has them.",
    ok: true,
  };
}
