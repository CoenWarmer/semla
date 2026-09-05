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

import { cn } from "@/lib/utils";
import { turnNodeLabel, type LaidOutTurnNode } from "@/lib/session-turn-layout";

export type TurnGraphNodeData = LaidOutTurnNode;

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
        {node.entryCount} {node.entryCount === 1 ? "entry" : "entries"}
      </span>

      <Handle
        className="!bg-muted-foreground/40"
        position={Position.Right}
        type="source"
      />
    </div>
  );
}
