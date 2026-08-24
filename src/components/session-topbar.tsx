"use client";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { SessionMessage } from "@/hooks/use-session-messages";
import type { WorkflowRun } from "@/hooks/use-workflow-runs";
import type { WorkflowSnapshot } from "@/types/workflow";
import { ScanSearchIcon } from "lucide-react";
import { useState } from "react";
import { SessionWorkflowPanel } from "./session-workflow-panel";

interface SessionTopbarProps {
  title: string | null;
  sessionId: string;
  allRuns: WorkflowRun[];
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

export function SessionTopbar({
  title,
  sessionId,
  allRuns,
  messages,
  onAgentClick,
  sessionRunning,
  snapshot,
}: SessionTopbarProps) {
  const [inspectOpen, setInspectOpen] = useState(false);

  const totalCost = allRuns.reduce(
    (sum, run) => sum + (run.snapshot?.tokenUsage?.cost ?? 0),
    0,
  );
  const totalTokens = allRuns.reduce(
    (sum, run) => sum + (run.snapshot?.tokenUsage?.total ?? 0),
    0,
  );

  return (
    <>
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/40 px-6">
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {title ?? "Untitled session"}
        </h1>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {totalCost > 0 && (
            <span title="Total session cost">
              {formatCost(totalCost)}
            </span>
          )}
          {totalTokens > 0 && (
            <span className="tabular-nums" title="Total tokens used">
              {formatTokens(totalTokens)} tokens
            </span>
          )}
        </div>
      </div>

      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/40 px-4">
        <Button size="sm" variant="ghost" onClick={() => setInspectOpen(true)}>
          <ScanSearchIcon />
          Inspect
        </Button>
      </div>

      <Sheet open={inspectOpen} onOpenChange={setInspectOpen}>
        <SheetContent
          className="flex flex-col gap-0 p-0 sm:max-w-3xl"
          side="right"
        >
          <SheetHeader className="shrink-0 border-b px-6 py-4">
            <SheetTitle>Inspect</SheetTitle>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-auto p-4">
            <SessionWorkflowPanel
              messages={messages}
              onAgentClick={onAgentClick}
              sessionId={sessionId}
              sessionRunning={sessionRunning}
              snapshot={snapshot}
            />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
