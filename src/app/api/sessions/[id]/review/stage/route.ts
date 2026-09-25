import { NextResponse } from "next/server";

import {
  stageHunks,
  stageWholeFile,
  unstageHunks,
  unstageWholeFile,
} from "@/lib/pi/review/review-apply";
import { readFileDiff } from "@/lib/pi/review/review-diff";
import { buildPatch, type HunkSelector } from "@/lib/pi/review/review-patch";
import { messageFailure, withReviewFile } from "@/lib/pi/review/review-service";
import { readChangedFiles } from "@/lib/pi/review/review-status";
import { sessionAccessDenied } from "@/lib/auth/session-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Stage or unstage chosen hunks of one file, or the whole file at once.
 *
 * The direction decides which diff the hunk indexes refer to, and getting that
 * wrong would act on the wrong lines: staging selects from the worktree
 * against the index, while unstaging selects from the index against HEAD.
 * They are different diffs with independently numbered hunks, so the index
 * arriving from the client is only meaningful together with the direction it
 * came with.
 *
 * `whole: true` skips hunk selection entirely and calls `stageWholeFile` /
 * `unstageWholeFile` — the drag-to-stage gesture in the changed-files list
 * asks for this, since a row dropped into a bucket has not necessarily had
 * its diff fetched yet, and there is nothing hunk-shaped about "stage this
 * file" as a request. Those two functions are `git add` and `git restore
 * --staged`, which are correct for a tracked file exactly as they already
 * were for an untracked one — the untracked branch below is what first
 * needed them, not what they are limited to.
 *
 * `hunks` entries may be a bare hunk index or a `{ index, range }` sub-hunk
 * selector — a part of a hunk the operator split in the editor's gutter. Both
 * forms are `HunkSelector` and go to `buildPatch` unchanged; see its docblock
 * for what a range addresses.
 *
 * The repository comes from the session's own project links and the path is
 * contained inside it. Neither is the caller's to choose — see
 * `withReviewFile`.
 */
/**
 * Whether one entry of the body's `hunks` array is a selector at all.
 *
 * A malformed entry is dropped rather than failing the request, which is the
 * posture the integer filter this replaced already had: the array is a
 * selection made against a diff read, `buildPatch` skips any entry that no
 * longer resolves anyway (a stale index, an out-of-range slice), and a 400
 * for one bad entry would lose the operator's other, valid choices. What is
 * *not* dropped silently is an empty result, which the route already reports
 * as "none of those hunks are in the current diff".
 */
function isHunkSelector(value: unknown): value is HunkSelector {
  if (Number.isInteger(value)) return true;
  if (typeof value !== "object" || value === null) return false;

  const { index, range } = value as { index?: unknown; range?: unknown };
  if (!Number.isInteger(index)) return false;
  if (!Array.isArray(range) || range.length !== 2) return false;
  if (!range.every((bound) => Number.isInteger(bound))) return false;

  // An empty or inverted range names no lines, and `sliceHunk` would render a
  // `@@` header describing zero of them.
  return (range[0] as number) < (range[1] as number);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const denied = await sessionAccessDenied(id);
  if (denied) return denied;
  const body = await request.json().catch(() => null);

  const relPath = typeof body?.path === "string" ? body.path : null;
  const direction = body?.direction === "unstage" ? "unstage" : "stage";
  const whole = body?.whole === true;
  const hunks: HunkSelector[] = Array.isArray(body?.hunks)
    ? body.hunks.filter(isHunkSelector)
    : [];

  if (!relPath) {
    return NextResponse.json(
      { message: "A path is required.", ok: false },
      { status: 400 },
    );
  }

  return withReviewFile(
    {
      onFailure: messageFailure({
        project: "Not a file in one of this session's projects.",
      }),
      path: relPath,
      project: body?.project ?? null,
      sessionId: id,
    },
    async (target) => {
      const { files } = await readChangedFiles(target.root);
      const entry = files.find((file) => file.path === relPath);

      if (!entry) {
        return NextResponse.json(
          { message: "That file has no changes.", ok: false },
          { status: 404 },
        );
      }

      // An untracked file has no index entry, so there are no hunks to pick
      // between: staging it means adding it, whole. A tracked file reaches the
      // same two calls when the client asked for the whole file explicitly.
      if (entry.status === "untracked" || whole) {
        const result =
          direction === "stage"
            ? await stageWholeFile(target.root, relPath)
            : await unstageWholeFile(target.root, relPath);
        return NextResponse.json(result);
      }

      const diff = await readFileDiff(
        target.root,
        relPath,
        direction === "stage" ? "index" : "staged",
      );

      if (!diff) {
        return NextResponse.json({
          message:
            direction === "stage"
              ? "Nothing left to stage in that file."
              : "Nothing staged in that file.",
          ok: false,
        });
      }

      const patch = buildPatch(diff, hunks);
      if (!patch) {
        return NextResponse.json({
          message: diff.binary
            ? "git cannot say how a binary file changed, so it cannot be staged by hunk."
            : "None of those hunks are in the current diff. Reload and try again.",
          ok: false,
        });
      }

      const result =
        direction === "stage"
          ? await stageHunks(target.root, patch)
          : await unstageHunks(target.root, patch);

      return NextResponse.json(result);
    },
  );
}
