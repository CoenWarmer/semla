import { handleRouteError } from "@/lib/api-helpers";
import { buildSessionMessages } from "@/lib/pi/session-messages-payload";
import { readSessionMeta } from "@/lib/pi/session-meta";
import { requireSessionOwner } from "@/lib/session-auth";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    // allowMissing: a session created by its first prompt is polled before
    // it exists — returning 404 here caused the messages query to error
    // during that window. An empty session simply has no messages to return.
    const { user } = await requireSessionOwner(id, undefined, { allowMissing: true });
    const supabase = await createClient();

    // `?leaf=` names the branch a client is looking at; absent, the session's
    // recorded fallback (the leaf a turn last actually ran from); absent that
    // too, the default — the last entry in the file, same as Pi. See
    // docs/plans/branching-sessions.md §2.
    const requestedLeaf = new URL(request.url).searchParams.get("leaf");
    const leafId = requestedLeaf ?? readSessionMeta(id)?.leafId ?? null;

    return Response.json(
      await buildSessionMessages(supabase, id, user.id, leafId),
    );
  } catch (error) {
    return handleRouteError(error, "Unable to load session.");
  }
}
