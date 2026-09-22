import { NextResponse } from "next/server";

import { readCommitFileDiff, readFileDiffSet } from "@/lib/pi/review/review-diff";
import { readChangedFiles } from "@/lib/pi/review/review-status";
import {
  errorFailure,
  resolveSessionCommit,
  withReviewFile,
  type ReviewTarget,
} from "@/lib/pi/review/review-service";
import { changedFileFromCommit } from "@/lib/review/review-commit-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One changed file's hunks: the whole change since HEAD for the editor, and
 * the staged/unstaged split for the staging controls.
 *
 * The repository is resolved from the session's own project links and the path
 * is then contained inside it — neither is the caller's to choose. `withReviewFile`
 * runs that guard, reporting "Not a project this session is linked to." if the
 * project fails and the more specific "Invalid path" if only the containment
 * check fails. See `resolveReviewTarget` for why that matters even in a
 * single-user install.
 *
 * Whether the file is tracked is decided here from `git status`, not accepted
 * as a parameter. An untracked file needs a synthesized diff and a tracked one
 * does not, and a caller that got the flag wrong would be handed a "new file"
 * diff for a file that has existed for years.
 *
 * With `sha` the question is a different one: what did *that commit* do to
 * this file. The working tree is then not consulted at all — a file committed
 * and untouched since is clean, and a route that asked git status first would
 * 404 exactly the files a commit selection exists to show. `staged` and
 * `unstaged` come back null in that case, which is what tells the client there
 * is nothing to stage rather than leaving it to infer as much from a flag.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(request.url);
  const relPath = url.searchParams.get("path");
  const project = url.searchParams.get("project");

  if (!relPath) {
    return NextResponse.json({ error: "path required" }, { status: 400 });
  }

  return withReviewFile(
    {
      onFailure: errorFailure({
        path: "Invalid path",
        project: "Not a project this session is linked to.",
      }),
      path: relPath,
      project,
      sessionId: id,
    },
    async (target) => {
      const sha = url.searchParams.get("sha");
      if (sha) return commitHunks(id, target, sha, relPath);

      const { files } = await readChangedFiles(target.root);
      const entry = files.find((file) => file.path === relPath);

      // A file git does not report as changed has no hunks to show. Saying so is
      // better than synthesizing a diff that would describe the whole file as new.
      if (!entry) {
        return NextResponse.json(
          { error: "That file has no changes." },
          { status: 404 },
        );
      }

      const diffs = await readFileDiffSet(target.root, relPath, {
        untracked: entry.status === "untracked",
      });

      return NextResponse.json({ ...diffs, file: entry, project: target.link.path });
    },
  );
}

/**
 * One commit's change to one file.
 *
 * The commit is resolved through the session's own turn range rather than read
 * straight from the repository, so the route answers "what did this turn's
 * commit do" and not "show me any object in history" — see
 * `resolveSessionCommit`. A 400 therefore means the sha is not this session's,
 * and the 404 below means the commit is real but does not contain the path.
 */
async function commitHunks(
  sessionId: string,
  target: ReviewTarget,
  sha: string,
  relPath: string,
) {
  const commit = await resolveSessionCommit(sessionId, target, sha);
  if (!commit) {
    return NextResponse.json(
      { error: "Not a commit from this session's turn." },
      { status: 400 },
    );
  }

  const change = commit.fileChanges.find((entry) => entry.path === relPath);
  if (!change) {
    return NextResponse.json(
      { error: "That commit did not change this file." },
      { status: 404 },
    );
  }

  const full = await readCommitFileDiff(target.root, commit.sha, relPath);

  return NextResponse.json({
    commitSha: commit.sha,
    file: changedFileFromCommit(change),
    full,
    project: target.link.path,
    staged: null,
    unstaged: null,
    untracked: false,
  });
}
