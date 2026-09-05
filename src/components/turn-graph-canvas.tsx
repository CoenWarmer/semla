"use client";

/**
 * Draws a session's branch structure, and switches to a branch on click.
 *
 * The click itself never touches the server — it only reports the clicked
 * turn's id upward through `onNodeClick`. What that id *means* is the
 * caller's business: client-session-component.tsx turns it into a
 * `?leaf=<turnId>` navigation, which is the same write forking is (§3),
 * aimed at a different entry, and the server resolves it forward to whatever
 * the current tip of that branch is (session-leaf.ts) rather than pinning
 * the exact clicked entry. See docs/plans/branching-sessions.md §4.
 *
 * Modeled closely on code-map-panel.tsx: elk layout is async for the same
 * reason (it is a compiled Java library with no synchronous entry point), so
 * positions arrive a tick after the graph does, and that panel's pattern for
 * holding the pair together — never clearing state from inside the effect —
 * is reused rather than re-derived.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useNodesState,
  useReactFlow,
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

/** A node's laid-out box, the part `setCenter` needs and `FlowNode` alone does not carry. */
type LaidOutNodeData = { height?: number; width?: number };

const centerOnFlowNode = (
  setCenter: ReturnType<typeof useReactFlow>["setCenter"],
  node: FlowNode,
) => {
  // Width/height live on the laid-out data, not React Flow's own node fields
  // — toFlow() (in this file) sizes a node through `style`, so
  // `node.width`/`node.height` are unset until React Flow measures the DOM
  // element, which for a node that just arrived has not happened yet.
  const data = node.data as LaidOutNodeData | undefined;
  if (!data) return;

  void setCenter(
    node.position.x + (data.width ?? 0) / 2,
    node.position.y + (data.height ?? 0) / 2,
    { duration: 400, zoom: 1 },
  );
};

/**
 * Recenters the canvas on a node that just appeared — a new turn the
 * conversation just added, most often — or on one the operator clicked.
 *
 * A plain `fitView` on every layout would also fit a node the operator
 * dragged out of frame back into it, which reads as the canvas fighting a
 * deliberate pan; only a genuinely new id earns an automatic recenter. A
 * click is explicit, so it always earns one, including a second click on
 * the node already centered — `clickedId` carries a nonce (`clickSeq`) for
 * exactly that case, since two clicks on the same id would otherwise look
 * identical to this effect's dependencies.
 *
 * A child of `<Canvas>` rather than a hook call in `TurnGraphCanvas` itself:
 * `useReactFlow` only resolves inside the store `<ReactFlow>` provides to its
 * own children, and `TurnGraphCanvas` renders above that boundary — which is
 * also why the click cannot simply call `setCenter` from `handleNodeClick`
 * directly, and instead reaches this component through the `clickedId` prop.
 */
function CenterOnNewOrClickedNode({
  clickedId,
  nodes,
}: {
  clickedId: { clickSeq: number; id: string } | null;
  nodes: FlowNode[];
}) {
  const { setCenter } = useReactFlow();
  // Undefined until the first layout has been seen at all, so the very first
  // graph a session ever shows does not "recenter" on every one of its nodes
  // at once — fitView (Canvas's own default) already frames that view.
  const seenIds = useRef<Set<string> | undefined>(undefined);

  useEffect(() => {
    const previous = seenIds.current;
    const nextIds = new Set(nodes.map((node) => node.id));

    if (previous) {
      const added = nodes.find((node) => !previous.has(node.id));
      if (added) centerOnFlowNode(setCenter, added);
    }

    seenIds.current = nextIds;
  }, [nodes, setCenter]);

  // A click's own recenter is a second effect, on its own dependency — the
  // `clickSeq` nonce — rather than folded into the one above. Keeping them
  // separate means a click cannot be mistaken for "a node was added" (or vice
  // versa) by whichever branch happens to run first when both fire on the
  // same render, which a shared boolean guard would risk.
  useEffect(() => {
    if (!clickedId) return;
    const clicked = nodes.find((node) => node.id === clickedId.id);
    if (clicked) centerOnFlowNode(setCenter, clicked);
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [clickedId?.clickSeq, setCenter]);

  return null;
}

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
   * The clicked turn's id and whether it is the live one — the caller
   * decides what a click on each means (session-turn-graph.ts's `isLive`,
   * the same flag the node's own border reads). Never called for the
   * synthetic root turn (‹root›), which has no message and so nothing a
   * leaf could name.
   */
  onNodeClick?: (turnId: string, isLive: boolean) => void;
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

  // The clicked node, recentered on regardless of whether it was already on
  // screen — see CenterOnNewOrClickedNode. `clickSeq` is a nonce rather than
  // relying on `id` alone changing: clicking the same node twice in a row
  // (say, after panning away from it) is still two clicks that should each
  // recenter, and a state update to an unchanged `id` would not re-fire the
  // effect that reads it.
  const [clickedId, setClickedId] = useState<{
    clickSeq: number;
    id: string;
  } | null>(null);
  const clickSeqRef = useRef(0);

  const handleNodeClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      // The synthetic root turn (session-turn-graph.ts's ‹root›) has no
      // message of its own to name as a leaf — promptText is null only for
      // it, so that is the signal rather than comparing against a private id.
      const data = node.data as
        | { isLive?: boolean; promptText?: string | null }
        | undefined;
      if (data?.promptText === null) return;
      clickSeqRef.current += 1;
      setClickedId({ clickSeq: clickSeqRef.current, id: node.id });
      onNodeClick?.(node.id, data?.isLive ?? false);
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
            <CenterOnNewOrClickedNode clickedId={clickedId} nodes={nodes} />
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
