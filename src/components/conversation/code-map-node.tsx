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
  const clickable = Boolean(node.onOpen) && !node.external;

  const className = cn(
    "flex h-full w-full flex-col justify-center rounded-md border px-3 py-1.5 text-left transition-colors",
    node.external
      ? "border-dashed border-border/60 bg-muted/30 text-muted-foreground"
      : "border-border bg-card hover:bg-muted",
    node.isRoot && "border-primary ring-1 ring-primary/40",
    clickable && "cursor-pointer",
  );
  const title = node.external
    ? "Declared outside this project"
    : `${node.file}:${node.line}`;

  const content = (
    <>
      <Handle
        className="!bg-muted-foreground/40"
        position={Position.Top}
        type="target"
      />

      <span className="truncate font-medium text-xs leading-tight">
        {label}
      </span>
      <span className="truncate text-[10px] text-muted-foreground tabular-nums leading-tight">
        {node.external ? "external" : `${node.file}:${node.line}`}
      </span>

      <Handle
        className="!bg-muted-foreground/40"
        position={Position.Bottom}
        type="source"
      />
    </>
  );

  // Two different real elements rather than one div wearing an ARIA role:
  // a clickable node is a real <button>, which gets keyboard activation for
  // free, and a non-clickable one is a real <figure> — a diagram unit with
  // nothing to click. Neither needs a `role` attribute to say what it is.
  if (clickable) {
    return (
      <button
        className={className}
        onClick={() => node.onOpen?.(node.file, node.line)}
        title={title}
        type="button"
      >
        {content}
      </button>
    );
  }

  return (
    <figure className={className} title={title}>
      {content}
    </figure>
  );
}
