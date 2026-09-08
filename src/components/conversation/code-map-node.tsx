"use client";

/**
 * One function in the code map.
 *
 * Not built on ai-elements' Node: that one places its handles Left and Right and
 * fixes its width at `w-sm`, which suits the workflow panel's horizontal fan-out
 * and fights a top-down call graph. Callers above callees needs Top and Bottom
 * handles, and the width comes from the layout so a long name is not truncated.
 *
 * The file and line are always on the node rather than behind a hover. They are
 * what makes an edge checkable, and a diagram of code you cannot trace back to
 * the code is the thing this feature was built to avoid.
 */

import { Handle, Position, type NodeProps } from "@xyflow/react";

import { cn } from "@/lib/utils";
import type { LaidOutNode } from "@/lib/code-map/layout";

export type CodeMapNodeData = LaidOutNode & {
  isRoot: boolean;
  onOpen?: (file: string, line: number) => void;
};

export function CodeMapNode({ data }: NodeProps) {
  const node = data as unknown as CodeMapNodeData;
  const label = node.container ? `${node.container}.${node.name}` : node.name;

  return (
    <div
      className={cn(
        "flex h-full w-full flex-col justify-center rounded-md border px-3 py-1.5 text-left transition-colors",
        node.external
          ? "border-dashed border-border/60 bg-muted/30 text-muted-foreground"
          : "border-border bg-card hover:bg-muted",
        node.isRoot && "border-primary ring-1 ring-primary/40",
        node.onOpen && !node.external && "cursor-pointer",
      )}
      onClick={() => {
        if (!node.external) node.onOpen?.(node.file, node.line);
      }}
      title={node.external ? "Declared outside this project" : `${node.file}:${node.line}`}
    >
      <Handle
        className="!bg-muted-foreground/40"
        position={Position.Top}
        type="target"
      />

      <span className="truncate font-medium text-xs leading-tight">{label}</span>
      <span className="truncate text-[10px] text-muted-foreground tabular-nums leading-tight">
        {node.external ? "external" : `${node.file}:${node.line}`}
      </span>

      <Handle
        className="!bg-muted-foreground/40"
        position={Position.Bottom}
        type="source"
      />
    </div>
  );
}
