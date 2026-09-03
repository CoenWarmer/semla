import { NextResponse } from "next/server";

import {
  stageHunks,
  stageWholeFile,
  unstageHunks,
  unstageWholeFile,
} from "@/lib/pi/review-apply";
import { readFileDiff } from "@/lib/pi/review-diff";
import { buildPatch } from "@/lib/pi/review-patch";
import { resolveReviewFile, resolveReviewTarget } from "@/lib/pi/review-service";
import { readChangedFiles } from "@/lib/pi/review-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Stage or unstage chosen hunks of one file.
 *
 * The direction decides which diff the hunk indexes refer to, and getting that
 * wrong would act on the wrong lines: staging selects from the worktree
 * against the index, while unstaging selects from the index against HEAD.
 * They are different diffs with independently numbered hunks, so the index
 * arriving from the client is only meaningful together with the direction it
 * came with.
 *
 * The repository comes from the session's own project links and the path is
 * contained inside it. Neither is the caller's to choose — see
 * `resolveReviewTarget`.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json().catch(() => null);

  const relPath = typeof body?.path === "string" ? body.path : null;
  const direction = body?.direction === "unstage" ? "unstage" : "stage";
  const hunks: number[] = Array.isArray(body?.hunks)
    ? body.hunks.filter((value: unknown) => Number.isInteger(value))
    : [];

  if (!relPath) {
    return NextResponse.json(
      { message: "A path is required.", ok: false },
      { status: 400 },
    );
  }

  const target = await resolveReviewTarget(id, body?.project ?? null);
  if (!target || !resolveReviewFile(target, relPath)) {
    return NextResponse.json(
      { message: "Not a file in one of this session's projects.", ok: false },
      { status: 400 },
    );
  }

  const { files } = await readChangedFiles(target.root);
  const entry = files.find((file) => file.path === relPath);

  if (!entry) {
    return NextResponse.json(
      { message: "That file has no changes.", ok: false },
      { status: 404 },
    );
  }

  // An untracked file has no index entry, so there are no hunks to pick
  // between: staging it means adding it, whole.
  if (entry.status === "untracked") {
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
}
