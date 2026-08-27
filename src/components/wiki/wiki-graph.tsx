"use client";

import { useCallback } from "react";
import type { Node as FlowNode, Edge as FlowEdge, NodeProps } from "@xyflow/react";
import { Handle, MarkerType, Position } from "@xyflow/react";
import { Canvas } from "@/components/ai-elements/canvas";
import { Controls } from "@/components/ai-elements/controls";
import { cn } from "@/lib/utils";
import {
  NAV_GROUP_ORDER,
  NavGroup,
  navGroupFor,
  WikiLink,
  WikiPageMeta,
  WikiPageType,
} from "@/lib/wiki-types";

// ─── Layout constants ────────────────────────────────────────────────────────

const NODE_W = 172;
const NODE_H = 52;
const PAD = 14;           // padding inside group node
const HEADER_H = 28;      // group label bar height
const ROW_GAP = 72;       // per-node vertical step inside a group
const GROUP_COL_GAP = 240; // horizontal gap between group columns

const GROUP_W = NODE_W + PAD * 2;

function groupHeight(childCount: number) {
  return HEADER_H + PAD + childCount * ROW_GAP;
}

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

const GROUP_LABELS: Record<NavGroup, string> = {
  entity: "Entities",
  concept: "Concepts",
  synthesis: "Syntheses",
  analysis: "Analyses",
  requirement: "Requirements",
  source: "Sources",
  observation: "Observations",
};

// ─── Node components ─────────────────────────────────────────────────────────

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
        "flex flex-col justify-center rounded-md border bg-card px-3 py-2 transition-colors cursor-pointer",
        isSelected
          ? "border-primary ring-1 ring-primary"
          : "border-border/60 hover:border-border",
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

interface GroupNodeData extends Record<string, unknown> {
  label: string;
}

function WikiGroupNode({ data }: NodeProps<FlowNode<GroupNodeData>>) {
  return (
    <div className="h-full w-full rounded-lg border border-border/40 bg-secondary/30">
      <p className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {data.label}
      </p>
    </div>
  );
}

// nodeTypes must be stable — defined at module level, never inside a component.
const nodeTypes = {
  wikiPage: WikiPageNode,
  wikiGroup: WikiGroupNode,
};

// ─── Graph builder ───────────────────────────────────────────────────────────

function buildGraphElements(
  pages: Record<string, WikiPageMeta>,
  links: WikiLink[],
  selectedPath: string | null,
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  // Collect page paths per nav group, preserving NAV_GROUP_ORDER.
  const groupPaths: Partial<Record<NavGroup, string[]>> = {};
  for (const [path, meta] of Object.entries(pages)) {
    const group = navGroupFor(meta);
    groupPaths[group] ??= [];
    groupPaths[group]!.push(path);
  }

  // Present groups are the non-empty ones, in defined order.
  const activeGroups = NAV_GROUP_ORDER.filter((g) => groupPaths[g]?.length);

  // Collect groups per column and compute per-column total height.
  const colGroups: Record<number, NavGroup[]> = { 0: [], 1: [], 2: [] };
  for (const g of activeGroups) {
    colGroups[GROUP_COLUMN[g]].push(g);
  }

  const colHeight = (col: number) =>
    colGroups[col].reduce(
      (sum, g) => sum + groupHeight(groupPaths[g]!.length) + PAD,
      0,
    );

  const maxColH = Math.max(colHeight(0), colHeight(1), colHeight(2));

  // Build group + child nodes.
  const nodes: FlowNode[] = [];

  for (const col of [0, 1, 2]) {
    const groups = colGroups[col];
    if (!groups.length) continue;

    const totalH = colHeight(col);
    let y = (maxColH - totalH) / 2;
    const x = col * (GROUP_W + GROUP_COL_GAP);

    for (const group of groups) {
      const children = groupPaths[group]!;
      const gH = groupHeight(children.length);
      const groupId = `group:${group}`;

      // Group container node
      nodes.push({
        id: groupId,
        type: "wikiGroup",
        position: { x, y },
        style: { width: GROUP_W, height: gH },
        data: { label: GROUP_LABELS[group] },
        draggable: false,
        selectable: false,
      });

      // Child page nodes, positioned relative to parent
      children.forEach((path, idx) => {
        const meta = pages[path];
        nodes.push({
          id: path,
          type: "wikiPage",
          parentId: groupId,
          extent: "parent",
          position: { x: PAD, y: HEADER_H + PAD + idx * ROW_GAP },
          data: {
            label: meta.title,
            pageType: meta.type,
            isSelected: path === selectedPath,
          },
          draggable: false,
          selectable: false,
        });
      });

      y += gH + PAD;
    }
  }

  // Edges — use var() directly; this project defines --muted-foreground as oklch,
  // so hsl(var(...)) would produce invalid CSS and invisible edges.
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
      // Only navigate on page nodes, not group containers.
      if (!node.id.startsWith("group:")) {
        onNavigate(node.id);
      }
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
