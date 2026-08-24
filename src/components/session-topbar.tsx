"use client";

import { Button } from "@/components/ui/button";
import { useSessionCost } from "@/hooks/use-session-cost";
import { useContextCheckResult } from "@/hooks/use-context-check";
import { useSessionMessages } from "@/hooks/use-session-messages";
import type { SessionMessage } from "@/hooks/use-session-messages";
import type { WorkflowSnapshot } from "@/types/workflow";
import { ScanSearchIcon } from "lucide-react";
import { useState } from "react";
import { SessionWorkflowPanel } from "./session-workflow-panel";

interface SessionTopbarProps {
  title: string | null;
  sessionId: string;
  messages: SessionMessage[];
  onAgentClick: (agentId: number, runId: string) => void;
  sessionRunning?: boolean;
  snapshot?: WorkflowSnapshot;
}

function formatCost(cost: number): string {
  if (cost < 0.001) return `$${cost.toFixed(5)}`;
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(3)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

function ContextFillBar({ sessionId }: { sessionId: string }) {
  const messagesQuery = useSessionMessages(sessionId);
  const messages = messagesQuery.data?.messages ?? [];
  const contextWindow = messagesQuery.data?.contextWindow ?? null;

  // Most recent assistant message's inputTokens = current context size
  const latestInput = [...messages]
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
      <span className="text-xs text-muted-foreground capitalize">{data.quality}</span>
    </div>
  );
}

export function SessionTopbar({
  title,
  sessionId,
  messages,
  onAgentClick,
  sessionRunning,
  snapshot,
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
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {title ?? "Untitled session"}
        </h1>
        <div className="flex items-center gap-3 text-xs text-foreground">
          {totalTokens > 0 && (
            <span className="tabular-nums" title="Total tokens used">
              {formatTokens(totalTokens)} tokens
            </span>
          )}
          {totalCost > 0 && (
            <span title="Total session cost">{formatCost(totalCost)}</span>
          )}
        </div>
      </div>

      {/* Inspect bar */}
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-border/40 px-4">
        <ContextFillBar sessionId={sessionId} />
        <ContextQualityBadge sessionId={sessionId} />

        <div className="ml-auto flex items-center gap-2">
          {showAgents && (
            <span className="text-xs tabular-nums text-muted-foreground">
              {runningCount > 0 ? `${runningCount} running · ` : ""}
              {agentCount} {agentCount === 1 ? "agent" : "agents"}
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
        </div>
      </div>

      {inspectOpen && (
        <div className="shrink-0 border-b border-border/40 overflow-auto" style={{ height: 260 }}>
          <SessionWorkflowPanel
            messages={messages}
            onAgentClick={onAgentClick}
            sessionId={sessionId}
            sessionRunning={sessionRunning}
            snapshot={snapshot}
          />
        </div>
      )}
    </>
  );
}
