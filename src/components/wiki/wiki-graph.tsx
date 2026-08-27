"use client";

import { useState, useEffect, useCallback } from "react";
import type { Node as FlowNode, Edge as FlowEdge, NodeProps } from "@xyflow/react";
import { Handle, MarkerType, Position } from "@xyflow/react";
import ELK from "elkjs/lib/elk.bundled.js";
import { Canvas } from "@/components/ai-elements/canvas";
import { Controls } from "@/components/ai-elements/controls";
import { cn } from "@/lib/utils";
import { navGroupFor, WikiLink, WikiPageMeta, WikiPageType } from "@/lib/wiki-types";

// ─── Layout constants ────────────────────────────────────────────────────────

const NODE_W = 172;
const NODE_H = 52;
const HEADER_H = 32; // repo group label row
const PAD = 16;
const GROUP_GAP = 60;

const elk = new ELK();

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
  description?: string;
  expanded: boolean;
  onToggle: (id: string) => void;
}

function WikiPageNode({ id, data }: NodeProps<FlowNode<WikiNodeData>>) {
  const { label, pageType, navGroup, isSelected, description, expanded, onToggle } = data;
  return (
    <div
      className={cn(
        "flex flex-col rounded-md border bg-card px-3 py-2 transition-colors cursor-pointer",
        isSelected
          ? "border-primary ring-1 ring-primary"
          : "border-border/60 hover:border-border",
      )}
      style={{ width: NODE_W }}
      onClick={() => onToggle(id)}
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
      {expanded && description && (
        <p className="mt-2 border-t border-border/40 pt-2 text-[10px] leading-relaxed text-muted-foreground">
          {description}
        </p>
      )}
    </div>
  );
}

interface RepoGroupData extends Record<string, unknown> {
  label: string;
}

function WikiRepoGroup({ data }: NodeProps<FlowNode<RepoGroupData>>) {
  return (
    <div className="h-full w-full rounded-lg border border-border/40 bg-secondary/30">
      <p className="px-3 py-2 font-heading text-xs font-semibold">{data.label}</p>
    </div>
  );
}

const nodeTypes = { wikiPage: WikiPageNode, wikiRepo: WikiRepoGroup };

// ─── Type ordering for consistent isolated-node ordering within groups ───────

const TYPE_ORDER: Partial<Record<WikiPageType, number>> = {
  entity: 0,
  concept: 1,
  synthesis: 2,
  analysis: 3,
  requirement: 4,
  source: 5,
};

// ─── ELK layout ──────────────────────────────────────────────────────────────

type NodePos = { id: string; x: number; y: number };

async function computeLayout(
  pages: Record<string, WikiPageMeta>,
  links: WikiLink[],
): Promise<FlowNode[]> {
  // ── 1. Group paths by repo ──────────────────────────────────────────────
  const repoGroups = new Map<string, string[]>();
  for (const [path, meta] of Object.entries(pages)) {
    const repo = meta.repo ?? "Unknown";
    if (!repoGroups.has(repo)) repoGroups.set(repo, []);
    repoGroups.get(repo)!.push(path);
  }

  // Sort nodes within each group by type then title so isolated nodes of the
  // same type land near each other in the stress layout.
  for (const paths of repoGroups.values()) {
    paths.sort((a, b) => {
      const ma = pages[a];
      const mb = pages[b];
      const ta = TYPE_ORDER[ma.type] ?? 99;
      const tb = TYPE_ORDER[mb.type] ?? 99;
      return ta !== tb ? ta - tb : ma.title.localeCompare(mb.title);
    });
  }

  const validLinks = links.filter(({ source, target }) => source in pages && target in pages);

  // ── 2. Run ELK inside each repo group ──────────────────────────────────
  const groupNodePositions = new Map<string, NodePos[]>();
  const groupSizes = new Map<string, { w: number; h: number }>();

  for (const [repo, paths] of repoGroups) {
    const pathSet = new Set(paths);
    const intraEdges = validLinks
      .filter(({ source, target }) => pathSet.has(source) && pathSet.has(target))
      .map(({ source, target }) => ({
        id: `${source}__${target}`,
        sources: [source],
        targets: [target],
      }));

    const result = await elk.layout({
      id: `group-${repo}`,
      layoutOptions: {
        // Stress: force-directed, clusters connected nodes naturally.
        "elk.algorithm": "org.eclipse.elk.stress",
        // Bias toward wider-than-tall within each group.
        "elk.aspectRatio": "2.0",
        // Preferred length for edges so connected nodes sit close.
        "org.eclipse.elk.stress.desiredEdgeLength": "140",
        // Each connected component is laid out independently, then
        // components are packed together; isolated nodes each form
        // a single-node component and are placed side by side.
        "elk.separateConnectedComponents": "true",
        "elk.spacing.componentComponent": "30",
        // Fixed seed → stable layout across re-renders.
        "org.eclipse.elk.randomSeed": "42",
      },
      children: paths.map((path) => ({ id: path, width: NODE_W, height: NODE_H })),
      edges: intraEdges,
    });

    const positions: NodePos[] = (result.children ?? []).map((n) => ({
      id: n.id!,
      x: n.x ?? 0,
      y: n.y ?? 0,
    }));
    groupNodePositions.set(repo, positions);

    // Derive bounding box from child positions (ELK doesn't expose root w/h in types).
    const maxX = positions.reduce((m, n) => Math.max(m, n.x + NODE_W), NODE_W);
    const maxY = positions.reduce((m, n) => Math.max(m, n.y + NODE_H), NODE_H);
    const w = maxX + PAD * 2;
    const h = HEADER_H + maxY + PAD * 2;
    groupSizes.set(repo, { w, h });
  }

  // ── 3. Lay out groups left-to-right ────────────────────────────────────
  const flowNodes: FlowNode[] = [];
  let groupX = 0;

  for (const [repo, paths] of repoGroups) {
    const size = groupSizes.get(repo)!;
    const groupId = `repo:${repo}`;
    const posMap = new Map(
      (groupNodePositions.get(repo) ?? []).map((n) => [n.id, n]),
    );

    flowNodes.push({
      id: groupId,
      type: "wikiRepo",
      position: { x: groupX, y: 0 },
      style: { width: size.w, height: size.h },
      data: { label: repo },
      draggable: false,
      selectable: false,
    });

    for (const path of paths) {
      const meta = pages[path];
      const pos = posMap.get(path) ?? { x: 0, y: 0 };
      // Child positions are relative to the group; offset by header + padding.
      flowNodes.push({
        id: path,
        type: "wikiPage",
        parentId: groupId,
        extent: "parent",
        position: { x: pos.x + PAD, y: pos.y + HEADER_H + PAD },
        data: {
          label: meta.title,
          pageType: meta.type,
          navGroup: navGroupFor(meta),
          isSelected: false,
          description: meta.description,
          // expanded and onToggle are merged in at render time.
          expanded: false,
          onToggle: () => undefined,
        },
        draggable: false,
        selectable: false,
        style: { width: NODE_W },
      });
    }

    groupX += size.w + GROUP_GAP;
  }

  return flowNodes;
}

// ─── Component ───────────────────────────────────────────────────────────────

interface WikiGraphProps {
  pages: Record<string, WikiPageMeta>;
  links: WikiLink[];
  selectedPath: string | null;
  onNavigate: (path: string) => void;
}

export function WikiGraph({ pages, links, selectedPath, onNavigate }: WikiGraphProps) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [baseNodes, setBaseNodes] = useState<FlowNode[]>([]);
  const [edges, setEdges] = useState<FlowEdge[]>([]);

  const onToggle = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Re-run ELK when the page set or link set changes.
  useEffect(() => {
    setExpandedIds(new Set());

    const validLinks = links.filter(({ source, target }) => source in pages && target in pages);

    computeLayout(pages, links).then(setBaseNodes);

    setEdges(
      validLinks.map(({ source, target }) => ({
        id: `${source}__${target}`,
        source,
        target,
        type: "default",
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 10,
          height: 10,
          color: "var(--muted-foreground)",
        },
        style: { stroke: "var(--muted-foreground)", strokeWidth: 1 },
      })),
    );
  }, [pages, links]);

  // Merge per-render state (selection, expansion, toggle callback) into node
  // data without triggering a full ELK re-run.
  const nodes = baseNodes.map((node) =>
    node.type === "wikiPage"
      ? {
          ...node,
          data: {
            ...node.data,
            isSelected: node.id === selectedPath,
            expanded: expandedIds.has(node.id),
            onToggle,
          },
        }
      : node,
  );

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: FlowNode) => {
      if (node.type === "wikiPage") onToggle(node.id);
    },
    [onToggle],
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
      fitView
    >
      <Controls />
    </Canvas>
  );
}
