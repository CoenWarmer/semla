import { NextResponse } from "next/server";

import { branchNameFromBase } from "@/lib/git-status-display";
import { checkoutBranch, mergeIntoCurrent } from "@/lib/pi/git-actions";
import {
  EMPTY_GIT_STATUS,
  fetchCanonical,
  readGitStatus,
} from "@/lib/pi/git-status";
import { sessionProjectPath } from "@/lib/pi/session-project";

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

  if (action !== "merge" && action !== "checkout" && action !== "refresh") {
    return NextResponse.json({ ok: false, message: "Unknown action." }, { status: 400 });
  }

  const projectPath = await sessionProjectPath(id);
  if (!projectPath) {
    return NextResponse.json(
      { ok: false, message: "This session has no project." },
      { status: 400 },
    );
  }

  if (action === "refresh") {
    await fetchCanonical(projectPath);
    return NextResponse.json({ ok: true, message: "" });
  }

  const status = await readGitStatus(projectPath, { fetch: false });
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
