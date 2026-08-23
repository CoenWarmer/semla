import { useQuery } from "@tanstack/react-query";

import type { WorkflowSnapshot } from "@/types/workflow";

export type WorkflowRun = {
  created_at: string;
  error: string | null;
  mode: "background" | "foreground";
  run_id: string;
  snapshot: WorkflowSnapshot;
  status: "completed" | "failed" | "interrupted" | "paused" | "running" | "stopped";
  updated_at: string;
};

export const workflowRunsQueryKey = (sessionId: string) =>
  ["workflow-runs", sessionId] as const;

const fetchWorkflowRuns = async (sessionId: string) => {
  const response = await fetch(`/api/sessions/${sessionId}/workflows`);
  if (!response.ok) {
    throw new Error("Unable to load workflow runs.");
  }

  const { runs } = (await response.json()) as { runs: WorkflowRun[] };
  return runs;
};

const STALE_RUNNING_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes without an update

export const useWorkflowRuns = (sessionId: string) =>
  useQuery({
    queryFn: () => fetchWorkflowRuns(sessionId),
    queryKey: workflowRunsQueryKey(sessionId),
    refetchInterval: (query) => {
      const runs = query.state.data;
      if (!runs) return false;
      const now = Date.now();
      const hasActiveRun = runs.some(
        (run) =>
          run.status === "running" &&
          now - new Date(run.updated_at).getTime() < STALE_RUNNING_THRESHOLD_MS,
      );
      return hasActiveRun ? 2_000 : false;
    },
  });
