"use client";

/**
 * One turn in the branch graph.
 *
 * Modeled on code-map-node.tsx, but laid out left to right instead of
 * top-down — a branch graph reads as a timeline, and Left/Right handles are
 * what a left-to-right elk layout expects an edge to connect to.
 *
 * The click that switches branches (docs/plans/branching-sessions.md §4)
 * is wired one level up in turn-graph-canvas.tsx's React Flow `onNodeClick`,
 * not here — this component only ever renders what a node looks like.
 */
import { GitForkIcon } from "lucide-react";
import { Handle, Position, type NodeProps } from "@xyflow/react";

import { formatCost, formatTokens } from "@/components/token-usage";
import { cn } from "@/lib/utils";
import { turnNodeLabel, type LaidOutTurnNode } from "@/lib/session-turn-layout";

export type TurnGraphNodeData = LaidOutTurnNode;

/**
 * "3 tools · 1.3k tokens · $0.05", using the same formatters the rest of the
 * app reads spend through (token-usage.tsx) so a node's numbers round the
 * same way the header badge and the session totals do.
 *
 * Falls back to the entry count for a turn with nothing yet to report — a
 * user message the agent has not replied to has no tool calls and no usage,
 * and an empty second line would look like the node failed to load rather
 * than like a turn that has not finished.
 */
export function turnNodeSummary(node: Pick<LaidOutTurnNode, "cost" | "entryCount" | "tokens" | "toolCallCount">): string {
  const parts: string[] = [];
  if (node.toolCallCount > 0) {
    parts.push(`${node.toolCallCount} ${node.toolCallCount === 1 ? "tool" : "tools"}`);
  }
  if (node.tokens > 0) parts.push(`${formatTokens(node.tokens)} tokens`);
  if (node.cost > 0) parts.push(formatCost(node.cost));

  if (parts.length === 0) {
    return `${node.entryCount} ${node.entryCount === 1 ? "entry" : "entries"}`;
  }

  return parts.join(" \u00b7 ");
}

export function TurnGraphNode({ data }: NodeProps) {
  const node = data as unknown as TurnGraphNodeData;
  const label = turnNodeLabel(node);

  // The synthetic root turn (promptText null) is the one node
  // turn-graph-canvas.tsx's click handler refuses to act on — shown as
  // unclickable here too, so the cursor does not promise a switch that will
  // not happen.
  const isClickable = node.promptText !== null;

  return (
    <div
      className={cn(
        "flex h-full w-full flex-col justify-center gap-0.5 rounded-md border px-3 py-1.5 text-left transition-colors",
        node.isLive
          ? "border-primary bg-card ring-1 ring-primary/40"
          : "border-border/60 bg-muted/30 text-muted-foreground",
        isClickable && "cursor-pointer hover:bg-muted",
      )}
      title={
        !isClickable
          ? undefined
          : node.isLive
            ? "On the live conversation"
            : "Switch to this branch"
      }
    >
      <Handle
        className="!bg-muted-foreground/40"
        position={Position.Left}
        type="target"
      />

      <div className="flex items-center gap-1">
        {node.isFork && (
          <GitForkIcon className="size-3 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate font-medium text-xs leading-tight">
          {label}
        </span>
      </div>
      <span className="truncate text-[10px] text-muted-foreground tabular-nums leading-tight">
        {turnNodeSummary(node)}
      </span>

      <Handle
        className="!bg-muted-foreground/40"
        position={Position.Right}
        type="source"
      />
    </div>
  );
}
