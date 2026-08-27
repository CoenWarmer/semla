"use client";

import { useCallback } from "react";
import type { Node as FlowNode, Edge as FlowEdge, NodeProps } from "@xyflow/react";
import { Handle, MarkerType, Position } from "@xyflow/react";
import { Canvas } from "@/components/ai-elements/canvas";
import { Controls } from "@/components/ai-elements/controls";
import { cn } from "@/lib/utils";
import { navGroupFor, WikiLink, WikiPageMeta, WikiPageType } from "@/lib/wiki-types";

// ─── Layout constants ────────────────────────────────────────────────────────

const NODE_W = 172;
const NODE_H = 52;
const PAD = 14;
const HEADER_H = 32;
const ROW_GAP = 72;
const GROUP_GAP = 48; // horizontal gap between repo groups

const GROUP_W = NODE_W + PAD * 2;

function groupHeight(childCount: number) {
  return HEADER_H + PAD + childCount * ROW_GAP;
}

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
  navGroup: string;
  isSelected: boolean;
}

function WikiPageNode({ data }: NodeProps<FlowNode<WikiNodeData>>) {
  const { label, pageType, navGroup, isSelected } = data;
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
        {navGroup === "observation" ? "observation" : pageType}
      </p>
    </div>
  );
}

interface RepoGroupData extends Record<string, unknown> {
  label: string;
}

function WikiRepoGroup({ data }: NodeProps<FlowNode<RepoGroupData>>) {
  return (
    <div className="h-full w-full rounded-lg border border-border/40 bg-secondary/30">
      <p className="px-3 py-2 font-heading text-xs font-semibold">
        {data.label}
      </p>
    </div>
  );
}

// nodeTypes must be stable — defined at module level, never inside a component.
const nodeTypes = {
  wikiPage: WikiPageNode,
  wikiRepo: WikiRepoGroup,
};

// ─── Graph builder ───────────────────────────────────────────────────────────

function buildGraphElements(
  pages: Record<string, WikiPageMeta>,
  links: WikiLink[],
  selectedPath: string | null,
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  // Collect paths per repo, preserving insertion order.
  const repoPaths = new Map<string, string[]>();
  for (const [path, meta] of Object.entries(pages)) {
    const repo = meta.repo ?? "Unknown";
    if (!repoPaths.has(repo)) repoPaths.set(repo, []);
    repoPaths.get(repo)!.push(path);
  }

  const repos = [...repoPaths.keys()];
  const nodes: FlowNode[] = [];

  let x = 0;
  for (const repo of repos) {
    const children = repoPaths.get(repo)!;
    const gH = groupHeight(children.length);
    const groupId = `repo:${repo}`;

    nodes.push({
      id: groupId,
      type: "wikiRepo",
      position: { x, y: 0 },
      style: { width: GROUP_W, height: gH },
      data: { label: repo },
      draggable: false,
      selectable: false,
    });

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
          navGroup: navGroupFor(meta),
          isSelected: path === selectedPath,
        },
        draggable: false,
        selectable: false,
      });
    });

    x += GROUP_W + GROUP_GAP;
  }

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
      if (!node.id.startsWith("repo:")) {
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
