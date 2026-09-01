import { NextResponse } from "next/server";

import { branchNameFromBase } from "@/lib/git-status-display";
import { checkoutBranch, mergeIntoCurrent } from "@/lib/pi/git-actions";
import type { GitStatus } from "@/lib/git-status-display";
import { fetchCanonical, readGitStatus } from "@/lib/pi/git-status";
import { projectAbsolutePath, sessionProjects } from "@/lib/pi/session-project";

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
 * Act on one of the session's working copies: merge the canonical base in, or
 * switch to its branch.
 *
 * The request names an action and, now that a session can have several
 * projects, which of them to act on. That second part removed the property this
 * route used to hold for free — it took no path at all, so a caller could not
 * aim either operation at a repository of its choosing.
 *
 * It is restored the way `/api/projects/git` already restores it: the supplied
 * path is checked against an allowlist before anything runs. There the
 * allowlist is the workspace listing; here it is the projects *this* session is
 * linked to. The absolute path is then derived from the matched link rather
 * than taken from the request, and refs are still re-resolved here, so neither
 * the repository nor the ref is ever the caller's to choose.
 *
 * Omitting `path` acts on the anchor, which is what a single-project session
 * means by "its" working copy.
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

  const links = await sessionProjects(id);
  if (links.length === 0) {
    return NextResponse.json(
      { ok: false, message: "This session has no project." },
      { status: 400 },
    );
  }

  const requested = typeof body?.path === "string" ? body.path : null;
  const link = requested ? links.find((l) => l.path === requested) : links[0];
  if (!link) {
    return NextResponse.json(
      { ok: false, message: "Not a project this session is linked to." },
      { status: 400 },
    );
  }

  const projectPath = projectAbsolutePath(link);

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
