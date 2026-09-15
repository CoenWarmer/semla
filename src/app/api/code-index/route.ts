/**
 * The opt-in surface for the code index.
 *
 * GET lists every workspace project with its index state. POST starts an index
 * run for one project and returns immediately — see index-runs.ts for why it
 * cannot await. DELETE drops a project's index.
 *
 * The path in a POST or DELETE body is checked against the workspace listing
 * rather than trusted. It reaches an fs walk and a directory removal, and
 * "index /etc" or a `..` traversal must not be expressible; comparing against
 * the set of paths the workspace scanner actually found is a whitelist rather
 * than a filter, which is the check that does not need to anticipate the
 * attack. Semla is single-user and loopback-bound, so this is defence in depth
 * rather than the only thing standing there — but a route that takes a path and
 * deletes a directory should not be the place that relies on it.
 */

import { handleRouteError, requireUser } from "@/lib/api/api-helpers";
import { projectKey } from "@/lib/code-index/index-paths";
import { isIndexRunning, startIndexRun } from "@/lib/code-index/index-runs";
import { getProjectIndexStatuses } from "@/lib/code-index/status";
import { createLocalVectorStore } from "@/lib/code-index/store/local";
import { getWorkspaceProjects } from "@/lib/pi/workspace/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function knownProjectPath(path: unknown): Promise<string | null> {
  if (typeof path !== "string" || path.length === 0) return null;
  const projects = await getWorkspaceProjects();
  return projects.some((project) => project.path === path) ? path : null;
}

export async function GET() {
  try {
    await requireUser();
    return Response.json({ projects: await getProjectIndexStatuses() });
  } catch (error) {
    return handleRouteError(error, "Unable to load code index status.");
  }
}

export async function POST(request: Request) {
  try {
    await requireUser();
    const body = (await request.json().catch(() => null)) as { path?: unknown } | null;
    const path = await knownProjectPath(body?.path);

    if (path === null) {
      return Response.json(
        { error: "Request body must name a project from the workspace." },
        { status: 400 },
      );
    }

    // Reported rather than silently coalesced onto the running one: the caller
    // pressed a button, and "already running" is the honest answer.
    const alreadyRunning = isIndexRunning(path);
    const run = startIndexRun(path);

    if (run.error !== null && run.report === null && run.finishedAt !== null) {
      // Failed before starting — no credential — which is a configuration
      // answer, not a server fault.
      return Response.json({ error: run.error }, { status: 409 });
    }

    return Response.json({ started: !alreadyRunning, alreadyRunning, path }, { status: 202 });
  } catch (error) {
    return handleRouteError(error, "Unable to start indexing.");
  }
}

export async function DELETE(request: Request) {
  try {
    await requireUser();
    const body = (await request.json().catch(() => null)) as { path?: unknown } | null;
    const path = await knownProjectPath(body?.path);

    if (path === null) {
      return Response.json(
        { error: "Request body must name a project from the workspace." },
        { status: 400 },
      );
    }

    if (isIndexRunning(path)) {
      // Dropping the directory a run is writing into leaves it writing to
      // nothing and reporting success.
      return Response.json(
        { error: "An index run is in progress for this project." },
        { status: 409 },
      );
    }

    await createLocalVectorStore().drop(projectKey(path));
    return Response.json({ dropped: true, path });
  } catch (error) {
    return handleRouteError(error, "Unable to drop the index.");
  }
}
