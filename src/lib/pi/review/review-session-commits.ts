/**
 * Which of a turn's commits this session actually made.
 *
 * `readTurnCommits` answers `startSha..HEAD`, and that range is a fact about
 * the *repository*, not about the session. Anything committed in that window
 * lands in it: a commit the operator made by hand in a terminal, a commit
 * another session sharing the same working copy made (which review-panel.tsx
 * already warns about for changed files), a `git pull` fast-forward. Each one
 * became a dot in `ReviewCommitNav`, claiming authorship the session did not
 * have.
 *
 * The session's own commits are already recorded, independently and at the
 * moment they happen: `captureArtifacts` notices HEAD moved on a mutating tool
 * call and emits a `CommitArtifact` per commit in the move. That log is the
 * only session-scoped evidence of authorship there is — git itself cannot
 * distinguish the agent's `git commit` from the operator's, because both run
 * as the same user in the same repository — so it is what the nav is filtered
 * against.
 *
 * The trade this makes deliberately: a commit whose capture failed (the
 * snapshot chain missed, the append threw — both best-effort by construction)
 * disappears from the nav rather than being attributed to the session on the
 * strength of its timestamp. Under-showing a dot costs the operator a click
 * into `git log`; over-showing one tells them the agent did something it did
 * not do, and the panel exists to be trusted on exactly that question.
 */

import { readSessionArtifacts } from "@/lib/pi/artifacts/artifact-store";
import { SEMLA_ARTIFACT_DIR } from "@/lib/pi/runtime/runtime-config";

/**
 * The shas this session committed in `projectPath`, or null when the session
 * has no commit artifacts for that project at all.
 *
 * Null rather than an empty set, because the two mean different things to a
 * caller and only one of them is safe to filter on. An empty set is "this
 * session committed nothing here", which should hide every dot. Null is "there
 * is no commit evidence for this project" — which is also what a session whose
 * artifact log predates commit capture, or was truncated past it, looks like,
 * and filtering to nothing there would silently empty a nav that used to work.
 */
export function sessionCommitShas(
  sessionId: string,
  projectPath: string,
  dir: string = SEMLA_ARTIFACT_DIR,
): Set<string> | null {
  const artifacts = readSessionArtifacts(sessionId, dir);

  let sawProject = false;
  const shas = new Set<string>();

  for (const artifact of artifacts) {
    if (artifact.kind !== "commit") continue;
    sawProject = true;
    if (artifact.projectPath === projectPath) shas.add(artifact.sha);
  }

  return sawProject ? shas : null;
}

/**
 * Keep only the commits the session is on record as having made.
 *
 * Generic over the commit shape rather than typed to `TurnCommit`, so this is
 * usable from both the review assembly (which holds full commits) and any
 * caller holding nothing but shas, without either importing the other's type.
 */
export function filterSessionCommits<T extends { sha: string }>(
  commits: readonly T[],
  shas: Set<string> | null,
): T[] {
  if (!shas) return [...commits];
  return commits.filter((commit) => shas.has(commit.sha));
}
