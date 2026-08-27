"use client";

import { Button } from "@/components/ui/button";
import { useSessionCost } from "@/hooks/use-session-cost";
import { useContextInspections } from "@/hooks/use-context-check";
import { useSessionMessages } from "@/hooks/use-session-messages";
import type {
  SessionMessage,
  SessionToolCall,
} from "@/hooks/use-session-messages";
import type { WorkflowSnapshot } from "@/types/workflow";
import type { WorkflowRun } from "@/hooks/use-workflow-runs";
import { BotIcon, ScanSearchIcon } from "lucide-react";
import { useState } from "react";
import { GoalEditor } from "./goal-editor";
import { InspectorPanel } from "./inspector-panel";
import { SessionWorkflowPanel } from "./session-workflow-panel";
import { TokenUsage, formatTokens } from "./token-usage";
import { SessionContextWindowBar } from "./session-context-window-bar";

interface SessionTopbarProps {
  title: string | null;
  sessionId: string;
  goal?: string | null;
  onGoalSave?: (goal: string | null) => Promise<void>;
  messages: SessionMessage[];
  onAgentClick: (agentId: number, runId: string) => void;
  sessionRunning?: boolean;
  snapshot?: WorkflowSnapshot;
  toolCalls?: SessionToolCall[];
  workflowRuns?: WorkflowRun[];
}

type PanelMode = "agents" | "inspector" | null;

function ContextFillBar({ sessionId }: { sessionId: string }) {
  const messagesQuery = useSessionMessages(sessionId);
  const messages = messagesQuery.data?.messages ?? [];
  const contextWindow = messagesQuery.data?.contextWindow ?? null;

  const latestInput =
    [...messages]
      .reverse()
      .find((m) => m.role === "assistant" && m.inputTokens != null)
      ?.inputTokens ?? null;

  if (latestInput == null || contextWindow == null) return null;

  const pct = Math.min(100, (latestInput / contextWindow) * 100);
  const fillColor =
    pct >= 90 ? "bg-destructive" : pct >= 70 ? "bg-yellow-500" : "bg-primary";

  return (
    <div className="flex items-center gap-2 min-w-0">
      <div className="relative h-1.5 w-24 rounded-full bg-muted overflow-hidden shrink-0">
        <div
          className={`absolute inset-y-0 left-0 rounded-full transition-all ${fillColor}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs tabular-nums text-muted-foreground whitespace-nowrap">
        {formatTokens(latestInput)} / {formatTokens(contextWindow)}
      </span>
    </div>
  );
}

function ContextQualityDot({ sessionId }: { sessionId: string }) {
  const { data: inspections } = useContextInspections(sessionId);
  const latest = inspections?.[0];
  if (!latest) return null;

  const colors: Record<string, string> = {
    good: "bg-green-500",
    warning: "bg-yellow-500",
    degraded: "bg-destructive",
  };
  const dot = colors[latest.result.quality] ?? "bg-muted";
  return (
    <span
      className={`size-2 rounded-full shrink-0 ${dot}`}
      title={latest.result.summary}
    />
  );
}

export function SessionTopbar({
  title,
  sessionId,
  goal,
  onGoalSave,
  messages,
  onAgentClick,
  sessionRunning,
  snapshot,
  toolCalls,
  workflowRuns,
}: SessionTopbarProps) {
  const [panelMode, setPanelMode] = useState<PanelMode>(null);
  const { cost: totalCost, tokens: totalTokens } = useSessionCost(sessionId);
  const { data: inspections } = useContextInspections(sessionId);
  const result = inspections?.[0]?.result ?? null;

  const agentCount = snapshot?.agentCount ?? 0;
  const runningCount = snapshot?.runningCount ?? 0;
  const showAgentCount = agentCount > 0 || runningCount > 0;

  function togglePanel(mode: PanelMode) {
    setPanelMode((prev) => (prev === mode ? null : mode));
  }

  return (
    <>
      {/* Title bar */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/40 px-6">
        {/* Left: session title */}
        <h1 className="w-40 shrink-0 truncate text-sm font-medium text-foreground">
          {title ?? "Untitled session"}
        </h1>

        {/* Center: goal */}
        <div className="flex min-w-0 flex-1 justify-center">
          {onGoalSave && (
            <div className="w-full max-w-lg">
              <GoalEditor
                goal={goal ?? null}
                onSave={onGoalSave}
                variant="inline"
              />
            </div>
          )}
        </div>

        {/* Right: controls */}
        <div className="flex shrink-0 items-center gap-2">
          <ContextFillBar sessionId={sessionId} />

          {/* Agent count — clicking opens the workflow panel */}
          {showAgentCount && (
            <button
              className="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground hover:bg-muted transition-colors"
              onClick={() => togglePanel("agents")}
              title="Show agent timeline"
            >
              <BotIcon className="size-3.5 shrink-0" />
              {runningCount > 0 ? `${runningCount} running · ` : ""}
              {agentCount + 1} {agentCount === 1 ? "agent" : "agents"}
            </button>
          )}

          {/* Inspect — opens context inspector panel */}
          <Button
            size="sm"
            variant={panelMode === "inspector" ? "secondary" : "ghost"}
            onClick={() => togglePanel("inspector")}
          >
            <ContextQualityDot sessionId={sessionId} />
            <ScanSearchIcon />
            Inspect
          </Button>

          <div className="flex items-center gap-3 text-xs text-foreground">
            <TokenUsage cost={totalCost} tokens={totalTokens} />
          </div>
        </div>
      </div>
      <SessionContextWindowBar result={result} />

      {/* Panel area */}
      {panelMode === "agents" && (
        <div
          className="shrink-0 border-b border-border/40 overflow-auto px-3"
          style={{ height: 348 }}
        >
          <SessionWorkflowPanel
            messages={messages}
            onAgentClick={onAgentClick}
            sessionId={sessionId}
            sessionRunning={sessionRunning}
            snapshot={snapshot}
            toolCalls={toolCalls}
            workflowRuns={workflowRuns}
          />
        </div>
      )}

      {panelMode === "inspector" && (
        <div
          className="shrink-0 border-b border-border/40 overflow-hidden px-3"
          style={{ height: 348 }}
        >
          <InspectorPanel goal={goal} sessionId={sessionId} />
        </div>
      )}
    </>
  );
}
