import { handleRouteError } from "@/lib/api-helpers";
import { requireSessionOwner } from "@/lib/session-auth";
import { createClient } from "@/lib/supabase/server";
import {
  getAgentDetail,
  verifyRunBelongsToSession,
} from "@/lib/pi/workflow-service";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; runId: string; agentId: string }> }
) {
  const { id, runId, agentId } = await params;

  try {
    await requireSessionOwner(id);
  } catch (error) {
    return handleRouteError(error, "Unable to authorize session.");
  }

  // Verify the run belongs to this session.
  const supabase = await createClient();
  const verification = await verifyRunBelongsToSession(supabase, id, runId);
  if (!verification.ok) {
    if (verification.status === 500) {
      console.error(
        "[api:sessions/workflows/agents] Unable to verify run:",
        verification.error,
      );
    }
    return Response.json(
      { error: verification.error },
      { status: verification.status },
    );
  }

  const numericId = parseInt(agentId, 10);
  const detail = getAgentDetail(runId, numericId);

  if ("reason" in detail) {
    if (detail.reason === "run-not-found") {
      return Response.json(
        { error: "Run file not available on this host." },
        { status: 404 }
      );
    }
    return Response.json({ error: "Agent not found." }, { status: 404 });
  }

  return Response.json({
    agent: detail.agent,
    runId,
    workflowName: detail.workflowName,
  });
}
