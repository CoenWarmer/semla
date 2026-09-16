/**
 * The two git facts phase 2's status is keyed on.
 *
 * A commit sha is the wrong key for phases 1 and 3 — the agent edits all turn
 * and commits at checkpoints, so the sha is constant across exactly the window
 * in which a code index goes stale, and it is blind to `mcp.json`, which lives
 * outside every project. It is the *right* key for the wiki, whose inputs are
 * README, AGENTS.md, dependency manifests, design docs and git history: things
 * that move on commit boundaries and are described by the commit graph. A wiki
 * page about a load-bearing decision does not go stale because a function body
 * changed.
 *
 * `dirty` is recorded because a capture taken against a dirty tree describes
 * something no sha identifies. That is the only honest way to represent it, and
 * it is what makes such a capture stale on sight (see wiki-status.ts).
 *
 * Both fields are nullable, which the plan's §5.3 schema is not. A directory
 * that is not a repository, and a repository with no commits, both genuinely
 * have no sha — and recording `""` there would be indistinguishable from a
 * field nothing ever wrote, which is the confidently-wrong shape this harness
 * refuses. `git()` already collapses every such failure to null.
 */

import { git, gitRaw } from "@/lib/pi/git/git";

export interface GitFacts {
  /** `git rev-parse HEAD`, or null when there is no HEAD to read. */
  commitSha: string | null;
  /** Whether the working tree had uncommitted changes. Null when unknown. */
  dirty: boolean | null;
}

export async function readGitFacts(root: string): Promise<GitFacts> {
  const [commitSha, porcelain] = await Promise.all([
    git(root, ["rev-parse", "HEAD"]),
    // gitRaw, not git: `git status --porcelain` puts a meaningful space in the
    // first column, and trimming shifts every field by one. Only emptiness is
    // read here, but the trimming version is the wrong primitive to reach for
    // on this command at all — see git.ts.
    gitRaw(root, ["status", "--porcelain"]),
  ]);

  return {
    commitSha,
    dirty: porcelain === null ? null : porcelain.trim().length > 0,
  };
}
