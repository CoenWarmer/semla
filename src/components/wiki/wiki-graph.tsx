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

const nodeTypes = { wikiPage: WikiPageNode };

// ─── Type ordering for deterministic isolated-node grouping ──────────────────

const TYPE_ORDER: Partial<Record<WikiPageType, number>> = {
  entity: 0,
  concept: 1,
  synthesis: 2,
  analysis: 3,
  requirement: 4,
  source: 5,
};

// ─── ELK layout ──────────────────────────────────────────────────────────────

async function computeLayout(
  pages: Record<string, WikiPageMeta>,
  links: WikiLink[],
): Promise<Map<string, { x: number; y: number }>> {
  const entries = Object.entries(pages);

  // Sort by type then title — ELK processes the node list in order, so
  // isolated (no-edge) nodes end up grouped by type in the output.
  entries.sort(([, a], [, b]) => {
    const ta = TYPE_ORDER[a.type] ?? 99;
    const tb = TYPE_ORDER[b.type] ?? 99;
    return ta !== tb ? ta - tb : a.title.localeCompare(b.title);
  });

  const validLinks = links.filter(({ source, target }) => source in pages && target in pages);

  const graph = {
    id: "root",
    layoutOptions: {
      // stress: force-directed, naturally clusters connected nodes.
      "elk.algorithm": "org.eclipse.elk.stress",
      // Wide aspect ratio → more horizontal spread.
      "elk.aspectRatio": "3.0",
      // Preferred distance between adjacent nodes along an edge.
      "org.eclipse.elk.stress.desiredEdgeLength": "200",
      // Each connected component is laid out separately; isolated nodes
      // each form a single-node component and are placed side by side.
      "elk.separateConnectedComponents": "true",
      "elk.spacing.componentComponent": "60",
      // Fixed seed for a stable result across renders.
      "org.eclipse.elk.randomSeed": "42",
    },
    children: entries.map(([path]) => ({
      id: path,
      width: NODE_W,
      height: NODE_H,
    })),
    edges: validLinks.map(({ source, target }) => ({
      id: `${source}__${target}`,
      sources: [source],
      targets: [target],
    })),
  };

  const result = await elk.layout(graph);
  return new Map(
    (result.children ?? []).map((n) => [n.id!, { x: n.x ?? 0, y: n.y ?? 0 }]),
  );
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

  const onToggle = useCallback(
    (id: string) => {
      setExpandedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        return next;
      });
    },
    [],
  );

  // Re-run ELK whenever the page set or link set changes.
  useEffect(() => {
    setExpandedIds(new Set());

    const validLinks = links.filter(({ source, target }) => source in pages && target in pages);

    computeLayout(pages, links).then((positions) => {
      const entries = Object.entries(pages);

      setBaseNodes(
        entries.map(([path, meta]) => ({
          id: path,
          type: "wikiPage",
          position: positions.get(path) ?? { x: 0, y: 0 },
          data: {
            label: meta.title,
            pageType: meta.type,
            navGroup: navGroupFor(meta),
            isSelected: path === selectedPath,
            description: meta.description,
            expanded: false,
            onToggle,
          },
          draggable: false,
          selectable: false,
          style: { width: NODE_W },
        })),
      );

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
    });
  }, [pages, links, onToggle]);

  // Merge per-render state (selection + expansion) into node data without
  // triggering a full ELK re-run.
  const nodes = baseNodes.map((node) => ({
    ...node,
    data: {
      ...node.data,
      isSelected: node.id === selectedPath,
      expanded: expandedIds.has(node.id),
      onToggle,
    },
  }));

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: FlowNode) => {
      onToggle(node.id);
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
