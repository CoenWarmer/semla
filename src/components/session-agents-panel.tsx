"use client";

import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { createPortal } from "react-dom";

import { useBottomPanel } from "@/components/bottom-panel";
import { countSessionAgents } from "@/lib/session-agent-counts";
import type { RecordedSpan } from "@/lib/pi/telemetry/span-sink";
import type {
  SessionMessage,
  SessionToolCall,
} from "@/hooks/use-session-messages";
import type { WorkflowRun } from "@/hooks/use-workflow-runs";
import type { WorkflowSnapshot } from "@/types/workflow";

import { SessionWorkflowPanel } from "./session-workflow-panel";

/** This panel's id in the shared bottom bar. See bottom-panel.tsx. */
const AGENTS_PANEL = "agents";

const agentsLabel = (count: number) =>
  `${count} ${count === 1 ? "agent" : "agents"}`;

/**
 * The agent timeline, in the bottom bar beside the console.
 *
 * It used to open below the title bar, which put a 360px panel between the
 * header and the conversation and pushed the reading area down the screen. The
 * bar is where a thing you glance at belongs, and the terminal already
 * established the shape.
 *
 * Rendered through portals rather than by the bar itself. `AppConsole` is in
 * the root layout, outside `{children}`, so that it stays put instead of
 * scrolling with the page — while everything this needs (the snapshot, the
 * spans, the live tool calls) belongs to the session tree and arrives on that
 * turn's stream. Portalling keeps the state where it is subscribed and gives
 * the bar no reason to know what a workflow is.
 */
export function SessionAgentsPanel({
  messages,
  onAgentClick,
  sessionId,
  sessionRunning,
  sessionTitle,
  show,
  snapshot,
  spans,
  toolCalls,
  workflowRuns,
}: {
  messages?: SessionMessage[];
  onAgentClick?: (agentId: number, runId: string) => void;
  sessionId?: string;
  sessionRunning?: boolean;
  /** Passed through so the timeline is named for what it draws. */
  sessionTitle?: string | null;
  /** Whether this session has anything to show a timeline for. */
  show: boolean;
  snapshot?: WorkflowSnapshot;
  spans?: readonly RecordedSpan[];
  toolCalls?: SessionToolCall[];
  workflowRuns?: WorkflowRun[];
}) {
  const bar = useBottomPanel();
  const counts = countSessionAgents({
    sessionRunning,
    snapshot,
    workflowRuns,
  });

  // Null outside the app frame, and the slots are null until the bar mounts.
  // Both mean "render nothing extra" rather than "throw".
  if (!bar || !show) return null;

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
            {/*
              Hidden at zero rather than shown as "0 agents", which beside a
              live green dot reads as a claim that something is running.
            */}
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
              {/* Hollow: used by the session, not working now. */}
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

      {/*
        Mounted only while open. Unlike the terminal — which stays mounted so
        collapsing does not kill the shell — this holds no connection, and the
        waterfall measures its own container, so keeping a hidden one alive
        would have it fitting spans to a box of zero width.
      */}
      {open &&
        bar.panelSlot &&
        createPortal(
          // Not `overflow-auto`: the panel scrolls its own span rows, so the
          // header stays put while they move under it.
          <div className="h-full overflow-hidden">
            <SessionWorkflowPanel
              messages={messages}
              onAgentClick={onAgentClick}
              sessionId={sessionId}
              sessionRunning={sessionRunning}
              sessionTitle={sessionTitle}
              snapshot={snapshot}
              spans={spans}
              toolCalls={toolCalls}
              workflowRuns={workflowRuns}
            />
          </div>,
          bar.panelSlot,
        )}
    </>
  );
}
