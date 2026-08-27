"use client";

import { useCallback } from "react";
import type { Node as FlowNode, Edge as FlowEdge, NodeProps } from "@xyflow/react";
import { Handle, MarkerType, Position } from "@xyflow/react";
import { Canvas } from "@/components/ai-elements/canvas";
import { Controls } from "@/components/ai-elements/controls";
import { cn } from "@/lib/utils";
import { NavGroup, navGroupFor, WikiLink, WikiPageMeta, WikiPageType } from "@/lib/wiki-types";

// ─── Layout constants ────────────────────────────────────────────────────────

const NODE_W = 176;
const NODE_H = 54;
const COL_GAP = 264;
const ROW_GAP = 84;

/** Left-to-right column index by nav group. */
const GROUP_COLUMN: Record<NavGroup, number> = {
  entity: 0,
  concept: 1,
  synthesis: 1,
  analysis: 1,
  requirement: 1,
  source: 2,
  observation: 2,
};

// ─── Node type ───────────────────────────────────────────────────────────────

const TYPE_ACCENT: Record<WikiPageType, string> = {
  entity: "text-blue-400",
  concept: "text-violet-400",
  synthesis: "text-amber-400",
  analysis: "text-green-400",
  requirement: "text-rose-400",
  source: "text-slate-400",
};

interface WikiNodeData extends Record<string, unknown> {
  label: string;
  pageType: WikiPageType;
  isSelected: boolean;
}

function WikiPageNode({ data }: NodeProps<FlowNode<WikiNodeData>>) {
  const { label, pageType, isSelected } = data;
  return (
    <div
      className={cn(
        "flex flex-col justify-center rounded-md border bg-card px-3 py-2 transition-colors",
        isSelected
          ? "border-primary ring-1 ring-primary"
          : "hover:border-border/80",
      )}
      style={{ width: NODE_W, height: NODE_H }}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!h-2 !w-2 !border-muted-foreground !bg-muted"
      />
      <Handle
        type="source"
        position={Position.Right}
        className="!h-2 !w-2 !border-muted-foreground !bg-muted"
      />
      <p className="truncate text-xs font-medium leading-tight">{label}</p>
      <p className={cn("mt-0.5 text-[10px]", TYPE_ACCENT[pageType])}>
        {pageType}
      </p>
    </div>
  );
}

// nodeTypes must be stable (defined at module level, not inside a component)
const nodeTypes = { wikiPage: WikiPageNode };

// ─── Graph builder ───────────────────────────────────────────────────────────

function buildGraphElements(
  pages: Record<string, WikiPageMeta>,
  links: WikiLink[],
  selectedPath: string | null,
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  // Group paths by column
  const columns: Record<number, string[]> = { 0: [], 1: [], 2: [] };
  for (const [path, meta] of Object.entries(pages)) {
    const col = GROUP_COLUMN[navGroupFor(meta)];
    columns[col].push(path);
  }

  // Compute max column height for vertical centering
  const maxRows = Math.max(...Object.values(columns).map((c) => c.length));
  const totalH = maxRows * ROW_GAP;

  const nodes: FlowNode[] = Object.entries(pages).map(([path, meta]) => {
    const col = GROUP_COLUMN[navGroupFor(meta)];
    const rowIdx = columns[col].indexOf(path);
    const colHeight = columns[col].length * ROW_GAP;
    const yOffset = (totalH - colHeight) / 2;
    return {
      id: path,
      type: "wikiPage",
      position: { x: col * COL_GAP, y: yOffset + rowIdx * ROW_GAP },
      data: {
        label: meta.title,
        pageType: meta.type,
        isSelected: path === selectedPath,
      },
      draggable: false,
      selectable: false,
    };
  });

  // Build edges directly from the pre-computed link pairs.
  // Use var(--muted-foreground) directly — this project uses OKLCH vars,
  // so wrapping in hsl() would produce invalid CSS and invisible edges.
  const edges: FlowEdge[] = links
    .filter(({ source, target }) => source in pages && target in pages)
    .map(({ source, target }) => ({
      id: `${source}__${target}`,
      source,
      target,
      type: "smoothstep",
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 10,
        height: 10,
        color: "var(--muted-foreground)",
      },
      style: { stroke: "var(--muted-foreground)", strokeWidth: 1 },
    }));

  return { nodes, edges };
}

// ─── Component ───────────────────────────────────────────────────────────────

interface WikiGraphProps {
  pages: Record<string, WikiPageMeta>;
  links: WikiLink[];
  selectedPath: string | null;
  onNavigate: (path: string) => void;
}

export function WikiGraph({
  pages,
  links,
  selectedPath,
  onNavigate,
}: WikiGraphProps) {
  const { nodes, edges } = buildGraphElements(pages, links, selectedPath);

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: FlowNode) => {
      onNavigate(node.id);
    },
    [onNavigate],
  );

  return (
    <Canvas
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodeClick={onNodeClick}
      nodesConnectable={false}
      edgesReconnectable={false}
      nodesDraggable={false}
    >
      <Controls />
    </Canvas>
  );
}
