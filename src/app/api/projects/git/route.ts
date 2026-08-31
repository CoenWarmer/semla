import { NextResponse } from "next/server";

import { branchNameFromBase } from "@/lib/git-status-display";
import { checkoutBranch, mergeIntoCurrent } from "@/lib/pi/git-actions";
import { readGitStatus } from "@/lib/pi/git-status";
import {
  getWorkspaceGitStatus,
  isWorkspaceProject,
  refreshProject,
} from "@/lib/pi/workspace-git";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Branch and divergence for every workspace project, keyed by path. */
export async function GET() {
  return NextResponse.json(await getWorkspaceGitStatus());
}

/**
 * Act on one workspace project: refresh its remote refs, merge the canonical
 * branch in, or check it out.
 *
 * Unlike the session route, the path comes from the client — so it is checked
 * against the workspace listing before anything runs. Only a directory the
 * workspace already reported as a project is addressable, and the refs each
 * action uses are still resolved here rather than accepted from the caller.
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const action = body?.action;
  const path = typeof body?.path === "string" ? body.path : null;

  if (action !== "merge" && action !== "checkout" && action !== "refresh") {
    return NextResponse.json({ ok: false, message: "Unknown action." }, { status: 400 });
  }
  if (!path || !(await isWorkspaceProject(path))) {
    return NextResponse.json(
      { ok: false, message: "Not a project in this workspace." },
      { status: 400 },
    );
  }

  if (action === "refresh") {
    await refreshProject(path);
    return NextResponse.json({ ok: true, message: "" });
  }

  const status = await readGitStatus(path, { fetch: false });
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
    return NextResponse.json(await mergeIntoCurrent(path, status.base));
  }

  const branch = branchNameFromBase(status.base);
  if (!branch) {
    return NextResponse.json({ ok: false, message: "No branch to check out." });
  }
  return NextResponse.json(await checkoutBranch(path, branch));
}
