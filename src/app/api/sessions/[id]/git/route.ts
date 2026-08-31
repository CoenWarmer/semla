import { NextResponse } from "next/server";

import { branchNameFromBase } from "@/lib/git-status-display";
import { checkoutBranch, mergeIntoCurrent } from "@/lib/pi/git-actions";
import { readGitStatus, EMPTY_GIT_STATUS } from "@/lib/pi/git-status";
import { readSessionMeta } from "@/lib/pi/session-meta";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The project a session works in.
 *
 * The disk record is authoritative and works without the database; the
 * Postgres row still answers for sessions created before it existed.
 */
async function sessionProjectPath(id: string): Promise<string | null> {
  const meta = readSessionMeta(id);
  if (meta) return meta.projectPath ?? null;

  const supabase = await createClient();
  const { data } = await supabase
    .from("sessions")
    .select("project_path")
    .eq("id", id)
    .maybeSingle();
  return data?.project_path ?? null;
}

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
  const projectPath = await sessionProjectPath(id);

  if (!projectPath) {
    return NextResponse.json({ projectPath: null, ...EMPTY_GIT_STATUS });
  }

  const status = await readGitStatus(projectPath);
  return NextResponse.json({ projectPath, ...status });
}

/**
 * Act on the session's working copy: merge the canonical base in, or switch to
 * its branch.
 *
 * The request names an action and nothing else. Refs are re-resolved here from
 * the same read the badge renders, so a caller cannot aim either operation at
 * a repository or a ref of its choosing.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json().catch(() => null);
  const action = body?.action;

  if (action !== "merge" && action !== "checkout") {
    return NextResponse.json({ ok: false, message: "Unknown action." }, { status: 400 });
  }

  const projectPath = await sessionProjectPath(id);
  if (!projectPath) {
    return NextResponse.json(
      { ok: false, message: "This session has no project." },
      { status: 400 },
    );
  }

  const status = await readGitStatus(projectPath);
  if (!status.base) {
    return NextResponse.json(
      { ok: false, message: "No canonical branch to compare against." },
      { status: 400 },
    );
  }

  if (action === "merge") {
    if (!status.branch) {
      return NextResponse.json({
        ok: false,
        message: "HEAD is detached; check out a branch first.",
      });
    }
    return NextResponse.json(await mergeIntoCurrent(projectPath, status.base));
  }

  const branch = branchNameFromBase(status.base);
  if (!branch) {
    return NextResponse.json({ ok: false, message: "No branch to check out." });
  }
  return NextResponse.json(await checkoutBranch(projectPath, branch));
}
