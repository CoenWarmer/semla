import { NextResponse } from "next/server";

import { readGitStatus, EMPTY_GIT_STATUS } from "@/lib/pi/git-status";
import { readSessionMeta } from "@/lib/pi/session-meta";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Branch and divergence for the project a session is working in.
 *
 * A session without a project — one started from the sidebar rather than a
 * project card — has nothing to report, and says so with nulls rather than an
 * error, so the caller can simply render nothing.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  // The disk record is authoritative and works without the database; the
  // Postgres row still answers for sessions created before it existed.
  const meta = readSessionMeta(id);
  let projectPath = meta?.projectPath ?? null;

  if (!meta) {
    const supabase = await createClient();
    const { data } = await supabase
      .from("sessions")
      .select("project_path")
      .eq("id", id)
      .maybeSingle();
    projectPath = data?.project_path ?? null;
  }

  if (!projectPath) {
    return NextResponse.json({ projectPath: null, ...EMPTY_GIT_STATUS });
  }

  const status = await readGitStatus(projectPath);
  return NextResponse.json({ projectPath, ...status });
}
