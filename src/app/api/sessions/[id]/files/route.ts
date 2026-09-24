import { NextResponse } from "next/server";

import {
  listDirectory,
  resolveFileRoot,
  resolveInsideRoot,
} from "@/lib/pi/workspace/file-browser";
import { sessionAccessDenied } from "@/lib/auth/session-auth";

export const runtime = "nodejs";

export type { FileEntry } from "@/lib/pi/workspace/file-browser";

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
  const denied = await sessionAccessDenied(id, { allowMissing: true });
  if (denied) return denied;
  const url = new URL(request.url);
  const relPath = url.searchParams.get("path") ?? "";
  const showHidden = url.searchParams.get("hidden") === "1";

  const { root, basePaths } = await resolveFileRoot(id);
  const targetRel = relPath || basePaths[0] || "";
  const targetPath = resolveInsideRoot(root, targetRel);

  if (!targetPath) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  try {
    const files = await listDirectory(targetPath, targetRel, showHidden);
    return NextResponse.json({ files, root, basePaths, path: targetRel });
  } catch {
    return NextResponse.json({ error: "Unable to read directory" }, { status: 500 });
  }
}
