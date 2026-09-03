"use client";

import { BotIcon, ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { createPortal } from "react-dom";

import { useBottomPanel } from "@/components/bottom-panel";
import type { RecordedSpan } from "@/lib/pi/telemetry/span-sink";
import type { SessionMessage, SessionToolCall } from "@/hooks/use-session-messages";
import type { WorkflowRun } from "@/hooks/use-workflow-runs";
import type { WorkflowSnapshot } from "@/types/workflow";

import { SessionWorkflowPanel } from "./session-workflow-panel";

/** This panel's id in the shared bottom bar. See bottom-panel.tsx. */
const AGENTS_PANEL = "agents";

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
  agentCount,
  messages,
  onAgentClick,
  runningCount,
  sessionId,
  sessionRunning,
  show,
  snapshot,
  spans,
  toolCalls,
  workflowRuns,
}: {
  agentCount: number;
  messages?: SessionMessage[];
  onAgentClick?: (agentId: number, runId: string) => void;
  runningCount: number;
  sessionId?: string;
  sessionRunning?: boolean;
  /** Whether this session has anything to show a timeline for. */
  show: boolean;
  snapshot?: WorkflowSnapshot;
  spans?: readonly RecordedSpan[];
  toolCalls?: SessionToolCall[];
  workflowRuns?: WorkflowRun[];
}) {
  const bar = useBottomPanel();

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
            className="flex items-center gap-1.5 rounded px-1 tabular-nums text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => bar.toggle(AGENTS_PANEL)}
            title="Show agent timeline"
            type="button"
          >
            <BotIcon className="size-3" />
            {runningCount > 0 ? `${runningCount} running · ` : ""}
            {agentCount + 1} {agentCount === 1 ? "agent" : "agents"}
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
          <div className="h-full overflow-auto p-3">
            <SessionWorkflowPanel
              messages={messages}
              onAgentClick={onAgentClick}
              sessionId={sessionId}
              sessionRunning={sessionRunning}
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
