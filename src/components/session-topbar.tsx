"use client";

import { Button } from "@/components/ui/button";
import { useSessionCost } from "@/hooks/use-session-cost";
import { useContextCheckResult } from "@/hooks/use-context-check";
import { useSessionMessages } from "@/hooks/use-session-messages";
import type {
  SessionMessage,
  SessionToolCall,
} from "@/hooks/use-session-messages";
import type { WorkflowSnapshot } from "@/types/workflow";
import { ScanSearchIcon } from "lucide-react";
import { useState } from "react";
import { GoalEditor } from "./goal-editor";
import { SessionWorkflowPanel } from "./session-workflow-panel";
import { TokenUsage, formatTokens } from "./token-usage";

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
}

function ContextFillBar({ sessionId }: { sessionId: string }) {
  const messagesQuery = useSessionMessages(sessionId);
  const messages = messagesQuery.data?.messages ?? [];
  const contextWindow = messagesQuery.data?.contextWindow ?? null;

  // Most recent assistant message's inputTokens = current context size
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

function ContextQualityBadge({ sessionId }: { sessionId: string }) {
  const { data } = useContextCheckResult(sessionId);
  if (!data) return null;

  const colors: Record<string, string> = {
    good: "bg-green-500",
    warning: "bg-yellow-500",
    degraded: "bg-destructive",
  };
  const dot = colors[data.quality] ?? "bg-muted";

  return (
    <div className="flex items-center gap-1.5" title={data.summary}>
      <span className={`size-2 rounded-full shrink-0 ${dot}`} />
      <span className="text-xs text-muted-foreground capitalize">
        {data.quality}
      </span>
    </div>
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
}: SessionTopbarProps) {
  const [inspectOpen, setInspectOpen] = useState(false);
  const { cost: totalCost, tokens: totalTokens } = useSessionCost(sessionId);

  const agentCount = snapshot?.agentCount ?? 0;
  const runningCount = snapshot?.runningCount ?? 0;
  const showAgents = agentCount > 0 || runningCount > 0;

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
              <GoalEditor goal={goal ?? null} onSave={onGoalSave} variant="inline" />
            </div>
          )}
        </div>

        {/* Right: controls */}
        <div className="flex shrink-0 items-center gap-2">
          <ContextFillBar sessionId={sessionId} />
          <ContextQualityBadge sessionId={sessionId} />

          {showAgents && (
            <span className="text-xs tabular-nums text-muted-foreground">
              {runningCount > 0 ? `${runningCount} running · ` : ""}
              {agentCount + 1} {agentCount === 1 ? "agent" : "agents"}
            </span>
          )}

          <Button
            size="sm"
            variant={inspectOpen ? "secondary" : "ghost"}
            onClick={() => setInspectOpen((v) => !v)}
          >
            <ScanSearchIcon />
            Inspect
          </Button>

          <div className="flex items-center gap-3 text-xs text-foreground">
            <TokenUsage cost={totalCost} tokens={totalTokens} />
          </div>
        </div>
      </div>

      {inspectOpen && (
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
          />
        </div>
      )}
    </>
  );
}
