import { NextResponse } from "next/server";

import { branchNameFromBase } from "@/lib/git-status-display";
import { checkoutBranch, mergeIntoCurrent } from "@/lib/pi/git-actions";
import type { GitStatus } from "@/lib/git-status-display";
import { fetchCanonical, readGitStatus } from "@/lib/pi/git-status";
import {
  projectAbsolutePath,
  sessionProjectPath,
  sessionProjects,
} from "@/lib/pi/session-project";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Branch and divergence for every project a session relates to, keyed by the
 * project's workspace-relative path.
 *
 * A record rather than one status, because a session can work in several
 * repositories and the header shows a badge for each. The same shape
 * `/api/projects/git` returns — though keyed differently, and deliberately:
 * each route keys by the identity its callers already hold, which is the
 * absolute path for a workspace project and the relative one for a link.
 *
 * A session with no projects returns `{}`, and the caller renders nothing.
 *
 * Unlike the workspace read, this one fetches. It is the indicator somebody is
 * actually looking at, and stale refs lie — `fetchCanonical` exists because a
 * branch once read "up to date" while hundreds of commits behind. The cost is
 * bounded by a session's handful of projects, each throttled to one fetch a
 * minute by GIT_FETCH_INTERVAL_MS.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const links = await sessionProjects(id);

  // Ordered primary first by sessionProjects, and JS preserves insertion order
  // for non-numeric keys — so a caller that has no particular project in mind
  // gets the anchor by taking the first entry.
  const statuses = await Promise.all(
    links.map((link) => readGitStatus(projectAbsolutePath(link))),
  );

  const byProject: Record<string, GitStatus> = {};
  links.forEach((link, index) => {
    byProject[link.path] = statuses[index];
  });

  return NextResponse.json(byProject);
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
