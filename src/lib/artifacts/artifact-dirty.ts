/**
 * Which files a session's projects still have uncommitted, for the one place
 * that makes a claim about it.
 *
 * The artifact log is append-only: a `diff` artifact records that a tool call
 * changed a file, and nothing ever revisits it when that file is later
 * committed. That is right for a log — it is the trace of what the session
 * did — and wrong for a row headed "uncommitted diff", which is a claim about
 * the working tree *now*. Reconciling the two needs git, so this module is
 * the join: `SessionReview` already reports every changed file per project
 * (see review-service.ts), and the session page already holds it under
 * `["review", sessionId]`, so this costs no new read.
 *
 * Kept out of artifact-groups.ts so that module stays a pure function of
 * chips, and out of review-types.ts because nothing in the review panel needs
 * it. Types only from both sides, so this stays client-safe.
 */

import type { SessionReview } from "@/lib/review/review-types";

/**
 * Uncommitted paths per workspace-relative project path.
 *
 * Project-relative paths inside each set, which is what both sides speak:
 * `ChangedFile.path` and `ArtifactFile.path` are both as git reports them.
 *
 * `undefined` — as opposed to an empty map — is "git has not been read yet",
 * and callers must treat it as unknown rather than as clean. A summary card
 * that renders before the review query settles would otherwise blink every
 * diff row out of existence and back.
 */
export type DirtyFiles = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * The dirty set from a review payload.
 *
 * A renamed file contributes both names: git reports the post-image path,
 * while an artifact captured before the rename recorded the old one, and both
 * describe the same uncommitted change.
 */
export function dirtyFilesFromReview(
  review: SessionReview | null | undefined,
): DirtyFiles | undefined {
  if (!review) return undefined;

  const byProject = new Map<string, Set<string>>();
  for (const project of review.projects) {
    const paths = new Set<string>();
    for (const file of project.changedFiles) {
      paths.add(file.path);
      if (file.oldPath) paths.add(file.oldPath);
    }
    byProject.set(project.path, paths);
  }
  return byProject;
}
