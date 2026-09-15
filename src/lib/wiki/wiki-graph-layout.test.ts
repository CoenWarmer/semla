import { describe, expect, it } from "vitest";
import { MultiGraph } from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import { WIKI_FA2_SETTINGS, layoutWikiGraph } from "./wiki-graph-layout";

/**
 * A vault in miniature: three repos of hub-and-leaf pages, plus a person
 * linking two of them. Same shape as the real graph, small enough to lay out
 * many times in a test.
 */
function buildFixture(): MultiGraph {
  const graph = new MultiGraph();
  const repos = ["alpha", "beta", "gamma"];
  const nodes: string[] = [];

  repos.forEach((repo, r) => {
    const hub = `${repo}/hub`;
    nodes.push(hub);
    // Seed on a circle, exactly as buildGraph does in wiki-graph.tsx.
    graph.addNode(hub, { x: 200 * Math.cos(r), y: 200 * Math.sin(r), size: 7 });
    for (let i = 0; i < 12; i++) {
      const leaf = `${repo}/leaf-${i}`;
      const angle = r * 2 + i / 4;
      nodes.push(leaf);
      graph.addNode(leaf, {
        x: 200 * Math.cos(angle),
        y: 200 * Math.sin(angle),
        size: 4,
      });
      graph.addEdge(hub, leaf);
    }
  });

  graph.addNode("people/coen", { x: 0, y: 200, size: 5 });
  graph.addEdge("people/coen", "alpha/hub");
  graph.addEdge("people/coen", "beta/hub");

  return graph;
}

const extent = (graph: MultiGraph) => {
  const xs = graph.mapNodes((_n, a) => a.x as number);
  const ys = graph.mapNodes((_n, a) => a.y as number);
  return Math.hypot(
    Math.max(...xs) - Math.min(...xs),
    Math.max(...ys) - Math.min(...ys),
  );
};

describe("layoutWikiGraph", () => {
  it("is deterministic for the same input", () => {
    const a = buildFixture();
    const b = buildFixture();
    layoutWikiGraph(a);
    layoutWikiGraph(b);

    a.forEachNode((key, attr) => {
      const other = b.getNodeAttributes(key);
      expect(other.x).toBeCloseTo(attr.x as number, 6);
      expect(other.y).toBeCloseTo(attr.y as number, 6);
    });
  });

  /** Extent after running ForceAtlas2 alone for a given budget. */
  const extentAfter = (
    iterations: number,
    settings: Record<string, unknown>,
  ) => {
    const graph = buildFixture();
    forceAtlas2.assign(graph, { iterations, settings });
    return extent(graph);
  };

  it("settles under the force stage, whatever the iteration budget", () => {
    // The bug this guards: the graph inflated for as long as the layout ran —
    // 13.9k units across at 200 iterations and 44.7k at 2400 on the real vault
    // — so a wall-clock cutoff meant a faster machine drew a different graph.
    // A force layout always jitters a little, so the test is that the envelope
    // stops growing, not that nodes stop moving.
    const growth =
      extentAfter(2400, WIKI_FA2_SETTINGS) / extentAfter(300, WIKI_FA2_SETTINGS);
    expect(growth).toBeGreaterThan(0.9);
    expect(growth).toBeLessThan(1.1);
  });

  it("would still inflate without strong gravity", () => {
    // Pins the cause rather than the symptom. Ordinary gravity cannot hold
    // against a scalingRatio of 50, which is what made the old layout grow for
    // as long as it ran — so the guard above is testing what it claims to.
    const weak = {
      ...WIKI_FA2_SETTINGS,
      strongGravityMode: false,
      gravity: 0.3,
    };
    const growth = extentAfter(2400, weak) / extentAfter(300, weak);
    expect(growth).toBeGreaterThan(1.5);
  });

  it("keeps the finished layout bounded once noverlap has run", () => {
    // Noverlap expands to clear collisions, and on a graph this small that is
    // a large fraction of the extent — so this is a bound, not a fixed point.
    // What matters is that it stays a bound as the budget grows.
    const short = buildFixture();
    const long = buildFixture();
    layoutWikiGraph(short, 300);
    layoutWikiGraph(long, 1200);

    const ratio = extent(long) / extent(short);
    expect(ratio).toBeGreaterThan(0.8);
    expect(ratio).toBeLessThan(1.25);
  });

  it("keeps the two settings that fix the two defects", () => {
    // Strong gravity is what bounds the layout. Linear attraction is what puts
    // hubs in the middle and lets repositories separate by colour — with
    // linLog the same vault scored 0.88 on repo separation against 2.88.
    expect(WIKI_FA2_SETTINGS.strongGravityMode).toBe(true);
    expect(WIKI_FA2_SETTINGS.linLogMode).toBe(false);
  });

  it("separates connected nodes rather than stacking them", () => {
    const graph = buildFixture();
    layoutWikiGraph(graph);

    const positions = graph.mapNodes((_n, a) => ({
      x: a.x as number,
      y: a.y as number,
    }));
    let closest = Infinity;
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        closest = Math.min(
          closest,
          Math.hypot(positions[i].x - positions[j].x, positions[i].y - positions[j].y),
        );
      }
    }
    expect(closest).toBeGreaterThan(1);
    expect(Number.isFinite(extent(graph))).toBe(true);
  });

  it("leaves an empty graph alone", () => {
    const graph = new MultiGraph();
    expect(() => layoutWikiGraph(graph)).not.toThrow();
    expect(graph.order).toBe(0);
  });
});
