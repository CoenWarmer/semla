import { handleRouteError } from "@/lib/api-helpers";
import { buildFileAccessTimeline } from "@/lib/pi/file-access/access-timeline";
import { withSubagentAccesses } from "@/lib/pi/file-access/subagent-accesses";
import { requireSessionOwner } from "@/lib/session-auth";

export const runtime = "nodejs";

/**
 * Every file this session's agents read or wrote, oldest first.
 *
 * Derived from the session file rather than from the transcript the client
 * already holds, because the transcript drops `details` and every non-scalar
 * argument — which is where an edit's changed line and a resolved symbol live.
 * Resolving paths here is also the only place the workspace root, the agent cwd
 * and the project links are all in scope.
 *
 * `?leaf=` selects a branch, matching the messages route, so the scrubber shows
 * the conversation the operator is actually looking at.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    await requireSessionOwner(id, undefined, { allowMissing: true });

    const leafId = new URL(request.url).searchParams.get("leaf");

    return Response.json(
      withSubagentAccesses(id, buildFileAccessTimeline(id, { leafId })),
    );
  } catch (error) {
    return handleRouteError(error, "Unable to load this session's file access.");
  }
}
