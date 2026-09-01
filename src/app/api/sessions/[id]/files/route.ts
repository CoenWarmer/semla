import { NextResponse } from "next/server";

import {
  listDirectory,
  resolveFileRoot,
  resolveInsideRoot,
} from "@/lib/pi/file-browser";

export const runtime = "nodejs";

export type { FileEntry } from "@/lib/pi/file-browser";

/**
 * List one directory of the session's workspace.
 *
 * With no `path`, the listing starts at the session's project rather than the
 * workspace root: a session opened from a project card is working in that
 * project, and making the reader walk down to it every time was busywork. The
 * paths returned stay workspace-relative, so the tree is simply rooted deeper —
 * nothing else in the API changes shape.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const relPath = new URL(request.url).searchParams.get("path") ?? "";

  const { root, basePath } = await resolveFileRoot(id);
  const targetRel = relPath || basePath || "";
  const targetPath = resolveInsideRoot(root, targetRel);

  if (!targetPath) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  try {
    const files = await listDirectory(targetPath, targetRel);
    return NextResponse.json({ files, root, basePath, path: targetRel });
  } catch {
    return NextResponse.json({ error: "Unable to read directory" }, { status: 500 });
  }
}
