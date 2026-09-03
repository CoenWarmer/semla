import { NextResponse } from "next/server";

import { readFileDiffSet } from "@/lib/pi/review-diff";
import { readChangedFiles } from "@/lib/pi/review-status";
import { resolveReviewFile, resolveReviewTarget } from "@/lib/pi/review-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One changed file's hunks: the whole change since HEAD for the editor, and
 * the staged/unstaged split for the staging controls.
 *
 * The repository is resolved from the session's own project links and the path
 * is then contained inside it — neither is the caller's to choose. See
 * `resolveReviewTarget` for why that matters even in a single-user install.
 *
 * Whether the file is tracked is decided here from `git status`, not accepted
 * as a parameter. An untracked file needs a synthesized diff and a tracked one
 * does not, and a caller that got the flag wrong would be handed a "new file"
 * diff for a file that has existed for years.
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

  const target = await resolveReviewTarget(id, project);
  if (!target) {
    return NextResponse.json(
      { error: "Not a project this session is linked to." },
      { status: 400 },
    );
  }

  if (!resolveReviewFile(target, relPath)) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

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
}
