import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.types";
import type { WorkflowSnapshot } from "@/types/workflow";
import { PI_WORKSPACE_ROOT } from "./runtime-config";
import {
  extractWorkflowDescription,
  readWorkflowRun,
  type PersistedAgentState,
} from "./workflow-run-reader";
import { getActiveManager } from "./workflow-manager-registry";
import { historyToTurns, mergeLiveSnapshot, type LiveSnapshot } from "./workflow-snapshot-merge";

/**
 * Build a live WorkflowSnapshot for a run.
 *
 * For running workflows, the disk file only updates when agents COMPLETE
 * (onAgentJournal fires at completion, not at start). Agents in "running" or
 * "queued" state are only visible in the WorkflowManager's in-memory snapshot.
 * We try the manager first so the UI shows agents as they start, then fall
 * back to the disk file once the run completes and the manager evicts it.
 */
export function snapshotFromRunFile(runId: string): WorkflowSnapshot | null {
  // Disk is authoritative for timestamps (written as agents complete). The
  // workflow extension falls back to process.cwd() when ctx.cwd isn't
  // propagated from the agent session (PI_WORKSPACE_ROOT may differ).
  const cwds = [...new Set([PI_WORKSPACE_ROOT, process.cwd()])];
  const runState = cwds.reduce<ReturnType<typeof readWorkflowRun>>(
    (found, cwd) => found ?? readWorkflowRun(cwd, runId),
    null,
  );

  // Backfill description from the script's meta literal if not stored directly.
  if (runState && !runState.workflowDescription) {
    runState.workflowDescription = extractWorkflowDescription(runState.script);
  }

  // The manager is the only source for agents that are queued or running, so
  // merge its status over the timestamps the run file has recorded so far.
  const live = (getActiveManager(runId)?.getSnapshot(runId) ?? null) as LiveSnapshot | null;
  if (live) {
    return mergeLiveSnapshot({ disk: runState, live, runId });
  }

  if (!runState) return null;

  const agents = runState.agents.map((a) => ({
    cost: a.tokenUsage?.cost,
    endedAt: a.endedAt,
    error: a.error,
    id: a.id,
    label: a.label,
    model: a.model,
    phase: a.phase,
    prompt: a.prompt ? a.prompt.slice(0, 200) : undefined,
    resultPreview:
      typeof a.result === "string"
        ? (a.result as string).slice(0, 300)
        : a.resultPreview,
    startedAt: a.startedAt,
    status: a.status,
    tokens: a.tokens,
    turns: a.history ? historyToTurns(a.history) : undefined,
  }));

  return {
    agentCount: agents.length,
    agents,
    completedAt: runState.completedAt,
    currentPhase: runState.currentPhase,
    description: runState.workflowDescription ?? extractWorkflowDescription(runState.script),
    doneCount: agents.filter((a) => a.status === "done").length,
    errorCount: agents.filter((a) => a.status === "error").length,
    name: runState.workflowName,
    phases: runState.phases,
    runId,
    runningCount: agents.filter((a) => a.status === "running").length,
    startedAt: runState.startedAt,
    tokenUsage: runState.tokenUsage
      ? { cost: runState.tokenUsage.cost, total: runState.tokenUsage.total }
      : undefined,
  };
}

/** Verify that a workflow run belongs to the given Semla session. */
export async function verifyRunBelongsToSession(
  supabase: SupabaseClient<Database>,
  semlaSessionId: string,
  runId: string,
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const { data: run, error } = await supabase
    .from("workflow_runs")
    .select("run_id")
    .eq("semla_session_id", semlaSessionId)
    .eq("run_id", runId)
    .maybeSingle();

  if (error) {
    return { error: error.message, ok: false, status: 500 };
  }
  if (!run) {
    return { error: "Workflow run not found.", ok: false, status: 404 };
  }

  return { ok: true };
}

export type AgentDetail = {
  cost?: number;
  endedAt?: string;
  error?: string;
  history: PersistedAgentState["history"];
  id: number;
  label: string;
  model?: string;
  phase?: string;
  prompt: string;
  startedAt?: string;
  status: PersistedAgentState["status"];
  tokens?: number;
};

export type AgentDetailResult =
  | { agent: AgentDetail; workflowName: string; reason?: undefined }
  | { reason: "run-not-found" | "agent-not-found" };

/** Look up a single agent's detail from a run's on-disk state. */
export function getAgentDetail(
  runId: string,
  agentId: number,
): AgentDetailResult {
  const runState = readWorkflowRun(PI_WORKSPACE_ROOT, runId);
  if (!runState) return { reason: "run-not-found" };

  const agent = runState.agents.find((a) => a.id === agentId);
  if (!agent) return { reason: "agent-not-found" };

  return {
    agent: {
      cost: agent.tokenUsage?.cost,
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
    workflowName: runState.workflowName,
  };
}
