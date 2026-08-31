/**
 * The failure that matters here is a cycle. Recursion and mutual recursion are
 * ordinary code, and a layered layout that has not been told to break cycles
 * either loops or stacks nodes on top of each other — neither of which announces
 * itself as an error, so both are asserted.
 */
import { describe, expect, it } from "vitest";

import { layoutCodeMap, nodeWidth } from "./layout.ts";
import type { CodeMap } from "./types.ts";

const node = (id: string, name = id) => ({
  container: null,
  external: false,
  file: "src/x.ts",
  id,
  kind: "function" as const,
  line: 1,
  name,
});

const mapOf = (
  ids: string[],
  edges: Array<[string, string]>,
): CodeMap => ({
  depth: 2,
  edges: edges.map(([from, to]) => ({ from, kind: "call" as const, sites: [1], to })),
  nodes: ids.map((id) => node(id)),
  root: ids[0],
  truncated: false,
  unresolved: [],
});

/** Do two laid-out boxes share any area? */
const overlaps = (
  a: { height: number; width: number; x: number; y: number },
  b: { height: number; width: number; x: number; y: number },
) =>
  a.x < b.x + b.width &&
  a.x + a.width > b.x &&
  a.y < b.y + b.height &&
  a.y + a.height > b.y;

describe("nodeWidth", () => {
  it("grows with the label so a long name is not truncated", () => {
    expect(nodeWidth({ name: "ensureLanguageServersOnPath" })).toBeGreaterThan(
      nodeWidth({ name: "run" }),
    );
  });

  it("keeps a floor so a short name is still a clickable target", () => {
    expect(nodeWidth({ name: "f" })).toBeGreaterThanOrEqual(140);
  });
});

describe("layoutCodeMap", () => {
  it("gives every node a position", async () => {
    const layout = await layoutCodeMap(mapOf(["a", "b", "c"], [["a", "b"], ["b", "c"]]));

    expect(layout.nodes).toHaveLength(3);
    expect(layout.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(
      true,
    );
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
  });

  it("puts a callee below its caller", async () => {
    const layout = await layoutCodeMap(mapOf(["a", "b"], [["a", "b"]]));
    const a = layout.nodes.find((n) => n.id === "a")!;
    const b = layout.nodes.find((n) => n.id === "b")!;

    expect(b.y).toBeGreaterThan(a.y);
  });

  it("survives mutual recursion without overlapping the pair", async () => {
    const layout = await layoutCodeMap(
      mapOf(["ping", "pong"], [["ping", "pong"], ["pong", "ping"]]),
    );

    expect(layout.nodes).toHaveLength(2);
    const [first, second] = layout.nodes;
    expect(overlaps(first, second)).toBe(false);
  });

  it("survives a self-call", async () => {
    const layout = await layoutCodeMap(mapOf(["loop"], [["loop", "loop"]]));

    expect(layout.nodes).toHaveLength(1);
    expect(Number.isFinite(layout.nodes[0].x)).toBe(true);
  });

  it("keeps both a call and a new edge between the same pair", async () => {
    const map = mapOf(["a", "b"], [["a", "b"]]);
    map.edges.push({ from: "a", kind: "new", sites: [9], to: "b" });

    // elk rejects duplicate edge ids; the kind has to be part of the key.
    const layout = await layoutCodeMap(map);
    expect(layout.edges).toHaveLength(2);
  });

  it("lays out nothing without throwing", async () => {
    const layout = await layoutCodeMap(mapOf([], []));

    expect(layout.nodes).toEqual([]);
    expect(layout.width).toBe(0);
  });
});
