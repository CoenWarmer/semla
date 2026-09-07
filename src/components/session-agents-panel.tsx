"use client";

import { useCallback, useMemo, Suspense } from "react";
import { createPortal } from "react-dom";
import { useParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { useBottomPanel } from "@/components/bottom-panel";
import {
  sessionAgentSelectionKey,
  useSessionLiveToolCalls,
  useSessionWorkflowComputedSnapshot,
} from "@/lib/session-live-state";
import { useSessionMessages } from "@/hooks/use-session-messages";
import { useWorkflowRuns } from "@/hooks/use-workflow-runs";
import { sessionSpansKey, fetchSessionSpans } from "@/lib/session-spans";
import { mergeToolCalls } from "@/lib/live-tool-calls";
import { sessionStatusKey, fetchSingleSessionStatus } from "@/lib/session-status";
import { countSessionAgents } from "@/lib/session-agent-counts";
import { SessionWorkflowPanel } from "./session-workflow-panel";

const EMPTY_TOOL_CALLS: import("@/hooks/use-session-messages").SessionToolCall[] = [];

/** This panel's id in the shared bottom bar. See bottom-panel.tsx. */
const AGENTS_PANEL = "agents";

const agentsLabel = (count: number) =>
  `${count} ${count === 1 ? "agent" : "agents"}`;

/**
 * The agent timeline's button and content share the bottom bar's slots with
 * the console, the branch graph and the element picker — the same button
 * row and the same expand area, one panel open at a time. The bar only owns
 * *where* things render; this component still sources all of its own data
 * from the query cache via useParams()+hooks (session-live-state.ts) rather
 * than receiving it as props, which is what actually let it move out from
 * under SessionTopbar and become a layout-level sibling in the first place.
 */
export function SessionAgentsPanel() {
  const { id } = useParams<{ id?: string }>();
  const sessionId = id;
  const bar = useBottomPanel();
  const queryClient = useQueryClient();

  // The computed snapshot, not the raw SSE one: client-session-component.tsx
  // writes this with a synthetic single-agent fallback for sessions running no
  // background workflow, so the panel has something to show for an ordinary
  // session too. The raw snapshot is undefined outside a workflow, which used
  // to make this panel (and its `!snapshot` visibility guard) disappear for
  // every non-workflow session.
  const snapshotQuery = useSessionWorkflowComputedSnapshot(sessionId ?? "");
  const workflowRunsQuery = useWorkflowRuns(sessionId ?? "");
  const liveToolCallsQuery = useSessionLiveToolCalls(sessionId ?? "");
  const messagesQuery = useSessionMessages(sessionId ?? "");
  const spansQuery = useQuery({
    enabled: !!sessionId,
    queryKey: sessionSpansKey(sessionId ?? ""),
    queryFn: () => fetchSessionSpans(sessionId ?? ""),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const statusQuery = useQuery({
    enabled: !!sessionId,
    queryKey: sessionStatusKey(sessionId ?? ""),
    queryFn: () => fetchSingleSessionStatus(sessionId ?? ""),
    refetchInterval: 5_000,
  });

  const snapshot = snapshotQuery.data ?? undefined;
  const workflowRuns = workflowRunsQuery.data;
  /**
   * Approximation: this polls the server's view, which only knows whether
   * the session process is alive. The page's `isActive` also factors in
   * `promptMutation.isPending` and `isReconnecting`, so this can read false
   * for a brief window while a prompt is being sent or the stream is
   * reconnecting. See docs/plans/session-live-state.md (pending).
   */
  const sessionRunning = statusQuery.data?.isRunning ?? false;

  const persistedToolCalls = messagesQuery.data?.toolCalls;
  const liveToolCalls = liveToolCallsQuery.data ?? EMPTY_TOOL_CALLS;
  const toolCalls = useMemo(
    () => mergeToolCalls(persistedToolCalls ?? [], liveToolCalls),
    [persistedToolCalls, liveToolCalls],
  );

  const counts = countSessionAgents({
    sessionRunning,
    snapshot,
    workflowRuns,
  });

  const handleAgentClick = useCallback(
    (agentId: number, runId: string) => {
      if (!sessionId) return;
      queryClient.setQueryData(sessionAgentSelectionKey(sessionId), {
        agentId,
        runId,
      });
    },
    [queryClient, sessionId],
  );

  // Null outside the app frame, and the slots are null until the bar mounts.
  // Both mean "render nothing extra" rather than "throw".
  if (
    !bar ||
    !sessionId ||
    (counts.running === 0 && counts.idle === 0 && !snapshot)
  ) {
    return null;
  }

  const open = bar.open === AGENTS_PANEL;

  return (
    <>
      {bar.barSlot &&
        createPortal(
          <button
            aria-expanded={open}
            className="flex items-center gap-2 rounded px-1 tabular-nums text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => bar.toggle(AGENTS_PANEL)}
            title="Show agent timeline"
            type="button"
          >
            {counts.running > 0 && (
              <span className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="size-1.5 shrink-0 rounded-full bg-emerald-500"
                />
                {agentsLabel(counts.running)}
              </span>
            )}

            <span className="flex items-center gap-1.5">
              <span
                aria-hidden
                className="size-1.5 shrink-0 rounded-full border border-current"
              />
              {agentsLabel(counts.idle)}
            </span>

            {open ? (
              <ChevronDownIcon className="size-3" />
            ) : (
              <ChevronUpIcon className="size-3" />
            )}
          </button>,
          bar.barSlot,
        )}

      {open &&
        snapshot &&
        bar.panelSlot &&
        createPortal(
          <div className="h-full overflow-hidden">
            <Suspense fallback={<Spinner className="size-4" />}>
              <SessionWorkflowPanel
                messages={messagesQuery.data?.messages}
                onAgentClick={handleAgentClick}
                sessionId={sessionId}
                sessionRunning={sessionRunning}
                snapshot={snapshot}
                spans={spansQuery.data}
                toolCalls={toolCalls}
                workflowRuns={workflowRuns}
              />
            </Suspense>
          </div>,
          bar.panelSlot,
        )}
    </>
  );
}
