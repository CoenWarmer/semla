"use client";

/**
 * Draws a session's branch structure.
 *
 * Read-only in the sense that a click here never moves the session's leaf
 * — docs/plans/branching-sessions.md phase 4 is what does that. What a click
 * does today is scroll the conversation to the clicked turn's opening
 * message, so the graph is also a way to navigate a long session rather than
 * only a diagram of it.
 *
 * Modeled closely on code-map-panel.tsx: elk layout is async for the same
 * reason (it is a compiled Java library with no synchronous entry point), so
 * positions arrive a tick after the graph does, and that panel's pattern for
 * holding the pair together — never clearing state from inside the effect —
 * is reused rather than re-derived.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  useNodesState,
  type Edge as FlowEdge,
  type Node as FlowNode,
  type NodeMouseHandler,
} from "@xyflow/react";

import { Canvas } from "@/components/ai-elements/canvas";
import { Controls } from "@/components/ai-elements/controls";
import { Spinner } from "@/components/ui/spinner";
import { TurnGraphNode } from "@/components/turn-graph-node";
import { useTurnGraph } from "@/hooks/use-turn-graph";
import { layoutTurnGraph, type TurnGraphLayout } from "@/lib/session-turn-layout";
import type { TurnGraph } from "@/lib/pi/session-turn-graph";

const nodeTypes = { turnGraphNode: TurnGraphNode };

function toFlow(layout: TurnGraphLayout): { edges: FlowEdge[]; nodes: FlowNode[] } {
  return {
    edges: layout.edges.map((edge) => ({
      id: `${edge.from}->${edge.to}`,
      source: edge.from,
      target: edge.to,
    })),
    nodes: layout.nodes.map((node) => ({
      data: node,
      draggable: true,
      id: node.id,
      position: { x: node.x, y: node.y },
      style: { height: node.height, width: node.width },
      type: "turnGraphNode",
    })),
  };
}

export function TurnGraphCanvas({
  onNodeClick,
  sessionId,
}: {
  /**
   * The clicked turn's id — the id of the user message it starts with, or
   * null for the synthetic root turn a session's pre-first-message entries
   * are grouped under, which has no message to jump to.
   */
  onNodeClick?: (turnId: string) => void;
  sessionId: string;
}) {
  const graphQuery = useTurnGraph(sessionId, true);
  const graph = graphQuery.data;

  // The laid-out result is stored *with* the graph it came from, the same
  // reason code-map-panel.tsx does: a layout still in flight for an older
  // graph must never be shown against a newer one, and clearing state from
  // inside the effect would cost a cascading render.
  const [resolved, setResolved] = useState<{
    graph: TurnGraph;
    layout: TurnGraphLayout;
  } | null>(null);

  useEffect(() => {
    if (!graph) return;

    let current = true;
    void layoutTurnGraph(graph).then((layout) => {
      if (current) setResolved({ graph, layout });
    });
    return () => {
      current = false;
    };
  }, [graph]);

  const flow = useMemo(
    () => (graph && resolved?.graph === graph ? toFlow(resolved.layout) : null),
    [graph, resolved],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);

  const handleNodeClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      // The synthetic root turn (session-turn-graph.ts's ‹root›) has no
      // message of its own to scroll to — promptText is null only for it,
      // so that is the signal rather than comparing against a private id.
      const data = node.data as { promptText?: string | null } | undefined;
      if (data?.promptText === null) return;
      onNodeClick?.(node.id);
    },
    [onNodeClick],
  );

  // Keep a node the operator has dragged where they put it when the layout is
  // recomputed on the next poll, the same way code-map-panel.tsx does.
  useEffect(() => {
    setNodes((previous) =>
      (flow?.nodes ?? []).map((next) => {
        const existing = previous.find((candidate) => candidate.id === next.id);
        return existing ? { ...next, position: existing.position } : next;
      }),
    );
  }, [flow, setNodes]);

  if (graphQuery.isError) {
    return (
      <div className="flex h-full items-center justify-center text-destructive text-xs">
        Unable to load this session&apos;s branches.
      </div>
    );
  }

  if (graph && graph.nodes.length <= 1) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-xs">
        No branches yet — every turn so far has continued from the one before it.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex shrink-0 items-center gap-x-3 text-xs">
        <span className="text-muted-foreground">
          {graph ? `${graph.nodes.length} turns` : "Loading…"}
        </span>
      </div>

      <div className="min-h-0 flex-1">
        {flow ? (
          <Canvas
            edges={flow.edges}
            fitViewOptions={{ padding: 0.2 }}
            nodeTypes={nodeTypes}
            nodes={nodes}
            nodesDraggable
            onNodeClick={handleNodeClick}
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
