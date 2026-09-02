/**
 * Reads a `CodeMap` back out of a `code_map` tool result.
 *
 * The map crosses a boundary here. It was produced inside the pi session by an
 * extension jiti loads from source, and it arrives as `unknown` on a tool
 * result. Nothing about that path is checked by the compiler, so it is checked
 * here instead — the same reasoning as getBackgroundWorkflowRunId in
 * session-events.ts, which validates its own result shape rather than casting.
 *
 * A malformed map returns null rather than throwing. A tool result that cannot
 * be read should cost the panel a drawing, not the turn.
 */

import type { CodeMap, CodeMapEdge, CodeMapNode } from "./types.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNode = (value: unknown): value is CodeMapNode =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.name === "string" &&
  typeof value.file === "string" &&
  typeof value.line === "number" &&
  typeof value.external === "boolean";

const isEdge = (value: unknown): value is CodeMapEdge =>
  isRecord(value) &&
  typeof value.from === "string" &&
  typeof value.to === "string" &&
  Array.isArray(value.sites);

/** Validate a value that should be a CodeMap. Null when it is not one. */
export function readCodeMap(value: unknown): CodeMap | null {
  if (!isRecord(value)) return null;
  if (typeof value.root !== "string") return null;
  if (!Array.isArray(value.nodes) || !value.nodes.every(isNode)) return null;
  if (!Array.isArray(value.edges) || !value.edges.every(isEdge)) return null;

  return {
    depth: typeof value.depth === "number" ? value.depth : 0,
    edges: value.edges,
    nodes: value.nodes,
    root: value.root,
    truncated: value.truncated === true,
    unresolved: Array.isArray(value.unresolved) ? value.unresolved : [],
  } as CodeMap;
}

/** Pull the map out of a `code_map` tool result, if there is a usable one. */
export function readCodeMapResult(result: unknown): CodeMap | null {
  if (!isRecord(result) || !isRecord(result.details)) return null;
  if (result.details.type !== "code-map") return null;

  return readCodeMap(result.details.map);
}
