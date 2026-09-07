import { handleRouteError } from "@/lib/api-helpers";
import { getSessionTurnGraph } from "@/lib/pi/session-turn-graph-loader";
import { requireSessionOwner } from "@/lib/session-auth";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * A session's branch structure, one node per turn.
 *
 * Read-only: docs/plans/branching-sessions.md phase 3. Switching branches
 * (phase 4) reuses ?leaf= on the messages route, not this one — this route
 * only describes the tree, it never resolves what a client should be
 * looking at.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    // allowMissing: same reason as the messages route — a new session is
    // polled before its first prompt creates it.
    await requireSessionOwner(id, undefined, { allowMissing: true });
    const supabase = await createClient();

    return Response.json(await getSessionTurnGraph(supabase, id));
  } catch (error) {
    return handleRouteError(error, "Unable to load this session's branches.");
  }
}
