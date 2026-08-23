import { handleRouteError } from "@/lib/api-helpers";
import { PI_WORKSPACE_ROOT } from "@/lib/pi/runtime-config";
import { requireSessionOwner } from "@/lib/session-auth";
import { createClient } from "@/lib/supabase/server";
import { readWorkflowRun } from "@/lib/pi/workflow-run-reader";

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
  const { data: run, error: runError } = await supabase
    .from("workflow_runs")
    .select("run_id")
    .eq("semla_session_id", id)
    .eq("run_id", runId)
    .maybeSingle();

  if (runError) {
    return Response.json({ error: runError.message }, { status: 500 });
  }
  if (!run) {
    return Response.json({ error: "Workflow run not found." }, { status: 404 });
  }

  const runState = readWorkflowRun(PI_WORKSPACE_ROOT, runId);
  if (!runState) {
    return Response.json(
      { error: "Run file not available on this host." },
      { status: 404 }
    );
  }

  const numericId = parseInt(agentId, 10);
  const agent = runState.agents.find((a) => a.id === numericId);

  if (!agent) {
    return Response.json({ error: "Agent not found." }, { status: 404 });
  }

  return Response.json({
    agent: {
      endedAt: agent.endedAt,
      error: agent.error,
      history: agent.history ?? [],
      id: agent.id,
      label: agent.label,
      model: agent.model,
      phase: agent.phase,
      prompt: agent.prompt,
      startedAt: agent.startedAt,
      status: agent.status,
      tokens: agent.tokens,
    },
    runId,
    workflowName: runState.workflowName,
  });
}
