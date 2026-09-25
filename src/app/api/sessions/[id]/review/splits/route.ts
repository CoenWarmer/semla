import { NextResponse } from "next/server";

import { readFileDiffSet } from "@/lib/pi/review/review-diff";
import { errorFailure, withReviewFile } from "@/lib/pi/review/review-service";
import {
  parseSplitsBody,
  pruneSplits,
  readFileSplits,
  validSplitKeys,
  writeFileSplits,
} from "@/lib/pi/review/review-split-store";
import { readChangedFiles } from "@/lib/pi/review/review-status";
import { sessionAccessDenied } from "@/lib/auth/session-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Where the operator has cut one file's hunks, read and replaced whole.
 *
 * Replaced whole rather than patched one cut at a time: the editor already
 * holds the file's complete set, so a full record is one request with no
 * ordering to get wrong between an add and a remove of the same boundary.
 * See review-split-store.ts for where it is kept and why git cannot keep it.
 *
 * The repository and path are resolved and contained exactly as the hunks
 * route does it — see `withReviewFile`.
 */

const FAILURE = errorFailure({
  path: "Invalid path",
  project: "Not a project this session is linked to.",
});

/** The file's current staged and unstaged diffs, or null if it has no changes. */
async function readStagingDiffs(root: string, relPath: string) {
  const { files } = await readChangedFiles(root);
  const entry = files.find((file) => file.path === relPath);
  if (!entry) return null;
  return readFileDiffSet(root, relPath, { untracked: entry.status === "untracked" });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const denied = await sessionAccessDenied(id);
  if (denied) return denied;
  const url = new URL(request.url);
  const relPath = url.searchParams.get("path");

  if (!relPath) {
    return NextResponse.json({ error: "path required" }, { status: 400 });
  }

  return withReviewFile(
    {
      onFailure: FAILURE,
      path: relPath,
      project: url.searchParams.get("project"),
      sessionId: id,
    },
    (target) => NextResponse.json({ splits: readFileSplits(target.root, relPath) }),
  );
}

/**
 * Replace a file's cuts, keeping only those its current diffs can still draw.
 *
 * The diffs are read here rather than trusting the client's set, because the
 * client's set is exactly what accumulates dead entries: a cut whose hunk has
 * since been staged, edited or committed is never looked up again and would
 * otherwise sit in the file for good.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const denied = await sessionAccessDenied(id);
  if (denied) return denied;
  const body = parseSplitsBody(await request.json().catch(() => null));

  if (!body) {
    return NextResponse.json({ error: "path and splits required" }, { status: 400 });
  }

  return withReviewFile(
    { onFailure: FAILURE, path: body.path, project: body.project, sessionId: id },
    async (target) => {
      const valid = validSplitKeys(await readStagingDiffs(target.root, body.path));
      const kept = pruneSplits(body.splits, valid);

      writeFileSplits(target.root, body.path, kept);
      return NextResponse.json({ splits: kept });
    },
  );
}
