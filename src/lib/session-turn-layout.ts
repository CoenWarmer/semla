/**
 * Positions a session's turn graph for drawing.
 *
 * Same reasoning as code-map/layout.ts, and the same library for the same
 * reason: a branched session is a tree with real forks, not a shape known in
 * advance, so elk's layered algorithm draws it. Left to right rather than
 * that module's top-down, with parents to the left of children — a branch
 * graph reads as a timeline, and a wide session fits a scrollable canvas
 * better than a tall one does. Kept as a separate module rather than a
 * shared one because a turn node's box is sized from a prompt's first line,
 * not a function name, and the two have no other overlap worth forcing
 * together.
 */
import ELK, { type ElkNode } from "elkjs/lib/elk.bundled.js";

import type { TurnGraph, TurnNode } from "@/lib/pi/session-turn-graph";

export const TURN_NODE_HEIGHT = 56;
const MIN_TURN_NODE_WIDTH = 160;
const MAX_TURN_NODE_WIDTH = 320;
const CHAR_WIDTH = 6.5;
const NODE_PADDING = 32;

export type LaidOutTurnNode = TurnNode & {
  height: number;
  width: number;
  x: number;
  y: number;
};

export type TurnGraphLayout = {
  edges: TurnGraph["edges"];
  height: number;
  nodes: LaidOutTurnNode[];
  width: number;
};

/** Label used to size the box: the prompt's first line, or a placeholder for the synthetic root. */
export function turnNodeLabel(node: Pick<TurnNode, "promptText">): string {
  return node.promptText ?? "(session start)";
}

function turnNodeWidth(node: Pick<TurnNode, "promptText">): number {
  const width = turnNodeLabel(node).length * CHAR_WIDTH + NODE_PADDING;
  return Math.max(MIN_TURN_NODE_WIDTH, Math.min(MAX_TURN_NODE_WIDTH, width));
}

const elk = new ELK();

export async function layoutTurnGraph(graph: TurnGraph): Promise<TurnGraphLayout> {
  if (graph.nodes.length === 0) {
    return { edges: [], height: 0, nodes: [], width: 0 };
  }

  const elkGraph: ElkNode = {
    children: graph.nodes.map((node) => ({
      height: TURN_NODE_HEIGHT,
      id: node.id,
      width: turnNodeWidth(node),
    })),
    edges: graph.edges.map((edge) => ({
      id: `${edge.from}->${edge.to}`,
      sources: [edge.from],
      targets: [edge.to],
    })),
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      // Left to right rather than top-down: a branch graph reads as a
      // timeline, and a wide session fits a scrollable canvas better than a
      // tall one does.
      "elk.direction": "RIGHT",
      "elk.layered.spacing.nodeNodeBetweenLayers": "56",
      "elk.spacing.nodeNode": "24",
      // A branched session's own history is the only cycle source this graph
      // could contain, and buildTurnGraph already refuses to produce one from
      // a malformed file \u2014 kept anyway, since elk offers no way to assert
      // "this graph has no cycles" and a silently overlapping layout is a
      // worse failure than a defensive option.
      "elk.layered.cycleBreaking.strategy": "GREEDY",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
    },
  };

  const laidOut = await elk.layout(elkGraph);
  const positions = new Map(
    (laidOut.children ?? []).map((child) => [
      child.id,
      {
        height: child.height ?? TURN_NODE_HEIGHT,
        width: child.width ?? MIN_TURN_NODE_WIDTH,
        x: child.x ?? 0,
        y: child.y ?? 0,
      },
    ]),
  );

  const nodes = graph.nodes.map((node) => {
    const position = positions.get(node.id);
    return {
      ...node,
      height: position?.height ?? TURN_NODE_HEIGHT,
      width: position?.width ?? turnNodeWidth(node),
      x: position?.x ?? 0,
      y: position?.y ?? 0,
    };
  });

  return {
    edges: graph.edges,
    height: laidOut.height ?? 0,
    nodes,
    width: laidOut.width ?? 0,
  };
}
