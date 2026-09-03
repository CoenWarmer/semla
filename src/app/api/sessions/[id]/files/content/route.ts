import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import { NextResponse } from "next/server";

import { resolveFileRoot, resolveInsideRoot } from "@/lib/pi/file-browser";

export const runtime = "nodejs";

/**
 * A file's identity as the client last saw it.
 *
 * Sent back on a write so the server can refuse to overwrite something that
 * moved underneath. A hash rather than an mtime: the agent and the operator
 * can both touch a file within the same second, and a timestamp comparison
 * would call that unchanged.
 */
const digest = (content: string) =>
  createHash("sha256").update(content).digest("hex").slice(0, 32);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const relPath = new URL(request.url).searchParams.get("path");

  if (!relPath) {
    return NextResponse.json({ error: "path required" }, { status: 400 });
  }

  const { root } = await resolveFileRoot(id);
  const targetPath = resolveInsideRoot(root, relPath);

  if (!targetPath) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  try {
    const content = await readFile(targetPath, "utf-8");
    return NextResponse.json({ content, path: relPath, sha: digest(content) });
  } catch {
    return NextResponse.json({ error: "Unable to read file" }, { status: 500 });
  }
}

/**
 * Write a file the operator edited in the review panel.
 *
 * The only write path in the application, so the two guards on it are worth
 * stating. Containment is `resolveInsideRoot`, which compares with `relative`
 * rather than a string prefix — `/Dev` prefixes `/Devil`, and a check that
 * accepts a sibling because its name starts the same way is not a check.
 *
 * The second guard is `sha`: the content the client last read. A review panel
 * is open precisely when an agent has been writing to these files, and a
 * background continuation or a second tab can move one while it sits open.
 * Refusing with 409 lets the panel say so; writing anyway would silently throw
 * away whichever change lost the race, which is the one outcome a surface
 * built for traceability must not produce.
 *
 * Omitting `sha` is allowed and means "create or overwrite regardless". The
 * panel always sends one; a caller that has no prior read has nothing to
 * compare and would be refused forever otherwise.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json().catch(() => null);

  const relPath = typeof body?.path === "string" ? body.path : null;
  const content = typeof body?.content === "string" ? body.content : null;
  const expected = typeof body?.sha === "string" ? body.sha : null;

  if (!relPath || content === null) {
    return NextResponse.json(
      { error: "path and content are required" },
      { status: 400 },
    );
  }

  const { root } = await resolveFileRoot(id);
  const targetPath = resolveInsideRoot(root, relPath);

  if (!targetPath) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  if (expected) {
    // A missing file is not a conflict: the operator may be restoring
    // something the agent deleted, and there is nothing to lose.
    const current = await readFile(targetPath, "utf-8").catch(() => null);
    if (current !== null && digest(current) !== expected) {
      return NextResponse.json(
        {
          error:
            "This file changed on disk since it was opened. Reload it to see " +
            "the current version before saving.",
        },
        { status: 409 },
      );
    }
  }

  try {
    await writeFile(targetPath, content, "utf-8");
    return NextResponse.json({ path: relPath, sha: digest(content) });
  } catch {
    return NextResponse.json({ error: "Unable to write file" }, { status: 500 });
  }
}
