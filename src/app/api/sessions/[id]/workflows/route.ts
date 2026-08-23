import { handleRouteError } from "@/lib/api-helpers";
import { PI_WORKSPACE_ROOT } from "@/lib/pi/runtime-config";
import { requireSessionOwner } from "@/lib/session-auth";
import { createClient } from "@/lib/supabase/server";
import { readWorkflowRun } from "@/lib/pi/workflow-run-reader";
import type { WorkflowSnapshot } from "@/types/workflow";

export const runtime = "nodejs";

// Build a live WorkflowSnapshot from the run file on disk.
// The DB snapshot starts empty for background runs because pi session events
// don't carry agent progress for background workflows — the run file is the
// authoritative source of agent state.
function snapshotFromRunFile(runId: string): WorkflowSnapshot | null {
  const runState = readWorkflowRun(PI_WORKSPACE_ROOT, runId);
  if (!runState) return null;

  const agents = runState.agents.map((a) => ({
    error: a.error,
    id: a.id,
    label: a.label,
    model: a.model,
    phase: a.phase,
    resultPreview:
      typeof a.result === "string"
        ? (a.result as string).slice(0, 300)
        : a.resultPreview,
    status: a.status,
    tokens: a.tokens,
  }));

  return {
    agentCount: agents.length,
    agents,
    currentPhase: runState.currentPhase,
    doneCount: agents.filter((a) => a.status === "done").length,
    errorCount: agents.filter((a) => a.status === "error").length,
    name: runState.workflowName,
    phases: runState.phases,
    runId,
    runningCount: agents.filter((a) => a.status === "running").length,
    tokenUsage: runState.tokenUsage
      ? { cost: runState.tokenUsage.cost, total: runState.tokenUsage.total }
      : undefined,
  };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    await requireSessionOwner(id);
  } catch (error) {
    return handleRouteError(error, "Unable to authorize session.");
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("workflow_runs")
    .select("*")
    .eq("semla_session_id", id)
    .order("updated_at", { ascending: false });

  if (error) {
    return Response.json(
      { error: `Unable to load workflow runs: ${error.message}` },
      { status: 500 }
    );
  }

  // For every run, prefer live data from the run file so agent progress is
  // always current (the DB snapshot is only updated for foreground runs).
  const runs = data.map((run) => {
    const liveSnapshot = snapshotFromRunFile(run.run_id);
    return { ...run, snapshot: liveSnapshot ?? run.snapshot };
  });

  return Response.json({ runs });
}
