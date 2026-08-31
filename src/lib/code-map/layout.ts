/**
 * Positions a code map for drawing.
 *
 * The workflow panel computes x/y by hand (COL_WIDTH, ROW_HEIGHT in
 * session-workflow-panel.tsx) because a workflow is one orchestrator fanning out
 * to a row of agents — a shape known in advance. A call graph has no such shape:
 * it is a general directed graph, and a real one contains cycles, because
 * recursion and mutual recursion are ordinary. Hand-positioning cannot do it.
 *
 * elkjs has been a dependency of this repository for some time without a caller.
 * This is its first: `layered` is the Sugiyama-style algorithm that draws
 * call graphs the way people sketch them, callers above callees, and it breaks
 * cycles itself rather than looping forever.
 *
 * Layout runs off the main work of the panel and is async, which is elkjs's own
 * API shape — it is a compiled Java library and does not offer a sync entry.
 */

import ELK, { type ElkNode } from "elkjs/lib/elk.bundled.js";

import type { CodeMap, CodeMapEdge, CodeMapNode } from "./types.ts";

/** Row height, and the vertical gap the layered algorithm leaves between ranks. */
export const NODE_HEIGHT = 52;
const MIN_NODE_WIDTH = 140;
const CHAR_WIDTH = 7.5;
const NODE_PADDING = 36;

export type LaidOutNode = CodeMapNode & {
  height: number;
  width: number;
  x: number;
  y: number;
};

export type CodeMapLayout = {
  edges: CodeMapEdge[];
  height: number;
  nodes: LaidOutNode[];
  width: number;
};

/**
 * Width a node needs for its label.
 *
 * Measured from the name rather than fixed, because `run` and
 * `ensureLanguageServersOnPath` in equal-width boxes wastes most of the canvas
 * on the short one and truncates the long one.
 */
export function nodeWidth(node: Pick<CodeMapNode, "name">): number {
  return Math.max(MIN_NODE_WIDTH, node.name.length * CHAR_WIDTH + NODE_PADDING);
}

const elk = new ELK();

export async function layoutCodeMap(map: CodeMap): Promise<CodeMapLayout> {
  if (map.nodes.length === 0) {
    return { edges: [], height: 0, nodes: [], width: 0 };
  }

  // Annotated rather than inferred: elk.layout() returns the shape it was given,
  // so an inferred literal type loses the width/height it computes on the root.
  const graph: ElkNode = {
    children: map.nodes.map((node) => ({
      height: NODE_HEIGHT,
      id: node.id,
      width: nodeWidth(node),
    })),
    // elk rejects duplicate edge ids, and one pair can legitimately have both a
    // "call" and a "new" edge, so the kind is part of the id.
    edges: map.edges.map((edge) => ({
      id: `${edge.from}->${edge.to}:${edge.kind}`,
      sources: [edge.from],
      targets: [edge.to],
    })),
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      // Callers above callees reads as flow; left-to-right reads as a tree and
      // runs out of width fast on a deep map.
      "elk.direction": "DOWN",
      "elk.layered.spacing.nodeNodeBetweenLayers": "72",
      "elk.spacing.nodeNode": "28",
      // Without this, a cycle makes the layered algorithm produce overlapping
      // ranks rather than choosing a back edge to reverse.
      "elk.layered.cycleBreaking.strategy": "GREEDY",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
    },
  };

  const laidOut = await elk.layout(graph);
  const positions = new Map(
    (laidOut.children ?? []).map((child) => [
      child.id,
      { height: child.height ?? NODE_HEIGHT, width: child.width ?? MIN_NODE_WIDTH, x: child.x ?? 0, y: child.y ?? 0 },
    ]),
  );

  const nodes = map.nodes.map((node) => {
    const position = positions.get(node.id);
    return {
      ...node,
      height: position?.height ?? NODE_HEIGHT,
      width: position?.width ?? nodeWidth(node),
      x: position?.x ?? 0,
      y: position?.y ?? 0,
    };
  });

  return {
    edges: map.edges,
    height: laidOut.height ?? 0,
    nodes,
    width: laidOut.width ?? 0,
  };
}
