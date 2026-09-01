import { readFile } from "node:fs/promises";

import { NextResponse } from "next/server";

import { resolveFileRoot, resolveInsideRoot } from "@/lib/pi/file-browser";

export const runtime = "nodejs";

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
    return NextResponse.json({ content, path: relPath });
  } catch {
    return NextResponse.json({ error: "Unable to read file" }, { status: 500 });
  }
}
