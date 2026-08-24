import { createClient } from "@/lib/supabase/server";
import { PI_WORKSPACE_ROOT } from "@/lib/pi/runtime-config";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";

export type FileEntry = {
  name: string;
  path: string;
  type: "file" | "directory";
};

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(request.url);
  const relPath = url.searchParams.get("path") ?? "";

  const supabase = await createClient();
  const { data: piSession } = await supabase
    .from("pi_sessions")
    .select("workspace_root")
    .eq("semla_session_id", id)
    .maybeSingle();

  const root = piSession?.workspace_root ?? PI_WORKSPACE_ROOT;
  const targetPath = relPath ? join(root, relPath) : root;

  if (!targetPath.startsWith(root)) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  try {
    const entries = readdirSync(targetPath, { withFileTypes: true });
    const files: FileEntry[] = entries
      .filter((e) => !e.name.startsWith("."))
      .map((e) => ({
        name: e.name,
        path: relPath ? `${relPath}/${e.name}` : e.name,
        type: (e.isDirectory() ? "directory" : "file") as "file" | "directory",
      }))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    return NextResponse.json({ files, root });
  } catch {
    return NextResponse.json({ error: "Unable to read directory" }, { status: 500 });
  }
}
