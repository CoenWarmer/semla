import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { useWorkflowRuns, workflowRunsQueryKey } from "@/hooks/use-workflow-runs";
import {
  sessionAgentSnapshot,
  sessionPanelSnapshot,
} from "@/lib/session/session-panel-snapshot";
import { sessionWorkflowComputedSnapshotKey } from "@/lib/session/session-live-state";
import type { WorkflowSnapshot } from "@/types/workflow";

/**
 * The session's workflow runs, as the phase bar and the agents panel draw them.
 *
 * Returns the phase bar's list. The agents panel's single snapshot is
 * published to the query cache instead, because `SessionAgentsPanel` lives in
 * the bottom bar — a layout-level sibling of this page, not a child — and the
 * cache is the only channel between the two. Which snapshot that is, is
 * decided in `sessionPanelSnapshot`.
 */
export function useSessionWorkflowSnapshots({
  activeTool,
  hasMessages,
  isActive,
  sessionId,
  workflowSnapshot,
}: {
  activeTool: string | undefined;
  hasMessages: boolean;
  isActive: boolean;
  sessionId: string;
  /** The live in-flight run from the stream, when there is one. */
  workflowSnapshot: WorkflowSnapshot | null | undefined;
}) {
  const queryClient = useQueryClient();
  const workflowRunId = workflowSnapshot?.runId;
  const workflowRunsQuery = useWorkflowRuns(sessionId, workflowRunId);

  // Re-fetch as soon as a background workflow starts: the first poll may have
  // come back empty, because the DB row is written a few seconds after the
  // "workflow-started" event arrives on the stream.
  useEffect(() => {
    if (workflowRunId) {
      void queryClient.invalidateQueries({ queryKey: workflowRunsQueryKey(sessionId) });
    }
  }, [workflowRunId, sessionId, queryClient]);

  const mostRecentRun = workflowRunsQuery.data?.[0];
  const panelSnapshot = useMemo(
    () =>
      sessionPanelSnapshot({
        fallback: sessionAgentSnapshot({ activeTool, hasMessages, isActive }),
        live: workflowSnapshot,
        mostRecentRun,
      }),
    [activeTool, hasMessages, isActive, mostRecentRun, workflowSnapshot],
  );

  useEffect(() => {
    queryClient.setQueryData(sessionWorkflowComputedSnapshotKey(sessionId), panelSnapshot);
  }, [queryClient, sessionId, panelSnapshot]);

  /**
   * Every run's snapshot for the conversation's phase bar, newest first.
   * Never the synthetic session-agent snapshot: a session that ran no
   * workflow yields an empty list, and the bar renders nothing.
   */
  return useMemo(
    () => (workflowRunsQuery.data ?? []).map((run) => run.snapshot),
    [workflowRunsQuery.data],
  );
}
