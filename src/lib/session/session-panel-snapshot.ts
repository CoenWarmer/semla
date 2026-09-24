/**
 * The one snapshot the agent timeline draws for a session.
 *
 * Three sources compete, and which wins is the whole point:
 *
 * - the live snapshot from the stream, current but missing agents the manager
 *   has not reported yet;
 * - the most recent persisted run, which can be *ahead* of the live one for the
 *   same run (the server has seen agents the stream has not delivered), or only
 *   a bare row whose snapshot has not been written yet;
 * - a synthetic single-agent snapshot for a session that ran no workflow, so
 *   the panel always has a node to draw.
 *
 * Kept apart from `workflowRunSnapshots` on purpose: the phase bar must never
 * receive the synthetic value, or a session with no workflow would grow a bar
 * describing its own main agent.
 */

import type { WorkflowRun } from "@/hooks/use-workflow-runs";
import type { WorkflowSnapshot } from "@/types/workflow";

/**
 * A run row's snapshot when it has the detail to draw, else a placeholder that
 * keeps a background workflow visible before its snapshot is populated.
 */
export function persistedRunSnapshot(run: WorkflowRun): WorkflowSnapshot {
  const snapshot = run.snapshot;
  if (typeof snapshot?.name === "string" && Array.isArray(snapshot.agents)) {
    return snapshot;
  }
  return {
    agentCount: 0,
    agents: [],
    doneCount: 0,
    errorCount: 0,
    name: `Workflow (${run.status})`,
    phases: [],
    runId: run.run_id,
    runningCount: run.status === "running" ? 1 : 0,
  };
}

/** The main agent as a single node, for a session running no workflow. */
export function sessionAgentSnapshot({
  activeTool,
  hasMessages,
  isActive,
}: {
  activeTool: string | undefined;
  hasMessages: boolean;
  isActive: boolean;
}): WorkflowSnapshot {
  return {
    agentCount: 1,
    agents: [
      {
        id: 0,
        label: activeTool ? `${activeTool}…` : "Session agent",
        status: isActive ? "running" : hasMessages ? "done" : "queued",
      },
    ],
    doneCount: isActive ? 0 : hasMessages ? 1 : 0,
    errorCount: 0,
    name: "Session",
    phases: [],
    runningCount: isActive ? 1 : 0,
  };
}

export function sessionPanelSnapshot({
  fallback,
  live,
  mostRecentRun,
}: {
  /** What to draw when there is no workflow at all. */
  fallback: WorkflowSnapshot;
  live: WorkflowSnapshot | null | undefined;
  mostRecentRun: WorkflowRun | undefined;
}): WorkflowSnapshot {
  const persisted = mostRecentRun ? persistedRunSnapshot(mostRecentRun) : undefined;

  if (
    live &&
    persisted &&
    live.runId === persisted.runId &&
    persisted.agents.length >= live.agents.length
  ) {
    return persisted;
  }
  return live ?? persisted ?? fallback;
}
