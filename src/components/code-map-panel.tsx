"use client";

/**
 * Draws the code map the `code_map` tool produced.
 *
 * The panel's job is to show the structure *and* its limits. A call graph is
 * always partial — bounded by depth, by the node cap, and by what a type checker
 * can resolve — and a diagram that renders only the confident part looks
 * complete when it is not. So truncation and unresolved calls are stated in the
 * header rather than left for the reader to notice they are missing.
 *
 * Layout is async because elkjs is (it is a compiled Java library with no
 * synchronous entry point), so positions arrive a tick after the map does.
 */

import { useEffect, useMemo, useState } from "react";
import { useNodesState, type Edge as FlowEdge, type Node as FlowNode } from "@xyflow/react";
import { AlertTriangleIcon, HelpCircleIcon } from "lucide-react";

import { Canvas } from "@/components/ai-elements/canvas";
import { Controls } from "@/components/ai-elements/controls";
import { CodeMapNode } from "@/components/code-map-node";
import { Spinner } from "@/components/ui/spinner";
import { layoutCodeMap, type CodeMapLayout } from "@/lib/code-map/layout";
import type { CodeMap } from "@/lib/code-map/types";

const nodeTypes = { codeMapNode: CodeMapNode };

function toFlow(
  layout: CodeMapLayout,
  rootId: string,
): { edges: FlowEdge[]; nodes: FlowNode[] } {
  return {
    edges: layout.edges.map((edge) => ({
      // The kind is part of the id: one pair can have both a call and a new
      // edge, and React Flow drops duplicates silently.
      id: `${edge.from}->${edge.to}:${edge.kind}`,
      label: edge.kind === "new" ? "new" : undefined,
      source: edge.from,
      style:
        edge.kind === "new"
          ? { stroke: "var(--color-muted-foreground)", strokeDasharray: "4 3" }
          : undefined,
      target: edge.to,
    })),
    nodes: layout.nodes.map((node) => ({
      data: { ...node, isRoot: node.id === rootId },
      draggable: true,
      id: node.id,
      position: { x: node.x, y: node.y },
      style: { height: node.height, width: node.width },
      type: "codeMapNode",
    })),
  };
}

export function CodeMapPanel({ map }: { map?: CodeMap }) {
  // The laid-out result is stored *with* the map it came from. Keeping the pair
  // together means a layout still in flight for an older map can never be shown
  // against a newer one — and it avoids clearing state from inside the effect,
  // which costs a cascading render.
  const [resolved, setResolved] = useState<{
    layout: CodeMapLayout;
    map: CodeMap;
  } | null>(null);
  const [showUnresolved, setShowUnresolved] = useState(false);

  useEffect(() => {
    if (!map) return;

    let current = true;
    void layoutCodeMap(map).then((layout) => {
      if (current) setResolved({ layout, map });
    });
    return () => {
      current = false;
    };
  }, [map]);

  const flow = useMemo(
    () => (map && resolved?.map === map ? toFlow(resolved.layout, map.root) : null),
    [map, resolved],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);

  // Keep a node the user has dragged where they put it when the layout is
  // recomputed, the same way session-workflow-panel.tsx does.
  useEffect(() => {
    setNodes((previous) =>
      (flow?.nodes ?? []).map((next) => {
        const existing = previous.find((candidate) => candidate.id === next.id);
        return existing ? { ...next, position: existing.position } : next;
      }),
    );
  }, [flow, setNodes]);

  if (!map) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-xs">
        No code map yet. Ask about a piece of code and Semla will draw one.
      </div>
    );
  }

  const root = map.nodes.find((node) => node.id === map.root);
  const rootLabel = root
    ? root.container
      ? `${root.container}.${root.name}`
      : root.name
    : map.root;

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="font-medium">{rootLabel}</span>
        {root && (
          <span className="text-muted-foreground tabular-nums">
            {root.file}:{root.line}
          </span>
        )}
        <span className="text-muted-foreground tabular-nums">
          {map.nodes.length} functions · {map.edges.length} calls · depth{" "}
          {map.depth}
        </span>

        {map.truncated && (
          <span
            className="flex items-center gap-1 text-yellow-500"
            title="Callees exist beyond this boundary; they are not drawn."
          >
            <AlertTriangleIcon className="size-3.5" />
            bounded
          </span>
        )}

        {map.unresolved.length > 0 && (
          <button
            className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setShowUnresolved((previous) => !previous)}
          >
            <HelpCircleIcon className="size-3.5" />
            {map.unresolved.length} unresolved
          </button>
        )}
      </div>

      {showUnresolved && (
        <div className="max-h-24 shrink-0 overflow-auto rounded border border-border/40 bg-muted/30 p-2 text-[11px] leading-relaxed">
          <p className="mb-1 text-muted-foreground">
            Real calls whose target the type checker could not determine:
          </p>
          {map.unresolved.slice(0, 30).map((item, index) => (
            <div className="tabular-nums" key={`${item.name}-${item.line}-${index}`}>
              <code>{item.name}</code> at L{item.line} —{" "}
              <span className="text-muted-foreground">{item.reason}</span>
            </div>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1">
        {flow ? (
          <Canvas
            edges={flow.edges}
            fitViewOptions={{ padding: 0.2 }}
            nodeTypes={nodeTypes}
            nodes={nodes}
            nodesDraggable
            onNodesChange={onNodesChange}
            panOnDrag
          >
            <Controls showInteractive={false} />
          </Canvas>
        ) : (
          <div className="flex h-full items-center justify-center">
            <Spinner className="size-4" />
          </div>
        )}
      </div>
    </div>
  );
}
