import { createClient } from "@/lib/supabase/server";
import { PI_WORKSPACE_ROOT } from "@/lib/pi/runtime-config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(request.url);
  const relPath = url.searchParams.get("path");

  if (!relPath) {
    return NextResponse.json({ error: "path required" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: piSession } = await supabase
    .from("pi_sessions")
    .select("workspace_root")
    .eq("semla_session_id", id)
    .maybeSingle();

  const root = piSession?.workspace_root ?? PI_WORKSPACE_ROOT;
  const targetPath = join(root, relPath);

  if (!targetPath.startsWith(root)) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  try {
    const content = readFileSync(targetPath, "utf-8");
    return NextResponse.json({ content, path: relPath });
  } catch {
    return NextResponse.json({ error: "Unable to read file" }, { status: 500 });
  }
}
