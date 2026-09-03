/**
 * How many agents a session is running, and how many it has finished with.
 *
 * Counted across every run the session has, not just the most recent one. The
 * bar's button used to read `snapshot.agentCount + 1`, where `snapshot` is the
 * latest run — so a session with two workflows reported only the second one's
 * agents, and the panel it opens draws all of them.
 *
 * The `+ 1` was, and still is, the session's own agent: the thing answering
 * prompts is an agent too, and the timeline gives it a row.
 */

import type { WorkflowSnapshot } from "@/types/workflow";

export type SessionAgentCounts = {
  /** Used by the session and no longer working. */
  idle: number;
  running: number;
};

/**
 * Every run's snapshot, one per run id, preferring the live one.
 *
 * A run that has just started is not in the polled list yet, and the polled
 * copy of a background run can be behind the live one — the same preference
 * the panel already applies when choosing which snapshot to draw.
 */
const snapshotsByRun = (
  snapshot: WorkflowSnapshot | undefined,
  runs: readonly { snapshot: WorkflowSnapshot | null }[],
): WorkflowSnapshot[] => {
  const byRun = new Map<string, WorkflowSnapshot>();

  for (const run of runs) {
    if (run.snapshot?.runId) byRun.set(run.snapshot.runId, run.snapshot);
  }
  // Last, so it wins. Skipped when it has no run id, which is what the
  // synthetic single-agent snapshot for a workflow-less session looks like —
  // that agent is the session's own, and counted as such below.
  if (snapshot?.runId) byRun.set(snapshot.runId, snapshot);

  return [...byRun.values()];
};

export const countSessionAgents = ({
  sessionRunning,
  snapshot,
  workflowRuns,
}: {
  sessionRunning?: boolean;
  snapshot?: WorkflowSnapshot;
  workflowRuns?: readonly { snapshot: WorkflowSnapshot | null }[];
}): SessionAgentCounts => {
  const agents = snapshotsByRun(snapshot, workflowRuns ?? []).flatMap(
    (run) => run.agents,
  );

  // "queued" is not running: it is an agent the run intends to start, and
  // showing it as live would put a green dot against work that has not begun.
  const running = agents.filter((agent) => agent.status === "running").length;

  return {
    idle: agents.length - running + (sessionRunning ? 0 : 1),
    running: running + (sessionRunning ? 1 : 0),
  };
};
