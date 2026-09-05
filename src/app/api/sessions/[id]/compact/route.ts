import { handleRouteError } from "@/lib/api-helpers";
import { compactPiSession } from "@/lib/pi/session-service";
import { requireSessionOwner } from "@/lib/session-auth";

export const runtime = "nodejs";

/**
 * Manually compact the session context.
 *
 * Compaction asks the model to summarise the conversation history into a
 * shorter form, then replaces the full history with that summary. The context
 * window bar drops after compaction — which is the point.
 *
 * The session must be loaded (have had at least one prompt turn in this
 * process) for compact() to reach the live AgentSession. A 409 is returned
 * when it is not.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    await requireSessionOwner(id);
  } catch (error) {
    return handleRouteError(error, "Unable to authorize session.");
  }

  try {
    await compactPiSession(id);
    return Response.json({ compacted: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to compact session.";
    if (message.includes("not live")) {
      return Response.json({ error: message }, { status: 409 });
    }
    return handleRouteError(error, "Unable to compact session.");
  }
}
