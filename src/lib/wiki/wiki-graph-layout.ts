import type Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import noverlap from "graphology-layout-noverlap";

/**
 * Layout for the /wiki graph.
 *
 * This runs synchronously for a fixed number of iterations rather than in a
 * worker for a fixed number of seconds. The distinction is the whole point:
 * a wall clock makes the result depend on how fast the machine is, so the
 * same vault laid out on two machines produced two different pictures.
 *
 * These settings were chosen by sweeping the parameter space against the real
 * vault; see scripts/wiki-layout-sweep.mjs, which scores a grid on whether the
 * layout settles, whether hubs read as central, how much canvas it wastes, and
 * how cleanly repositories separate by colour.
 */

/**
 * Two settings here fix two separate defects in what the graph used to do.
 *
 * `strongGravityMode` stops it inflating. Gravity alone could not hold against
 * a `scalingRatio` of 50, so the vault expanded for as long as the layout ran
 * — 13.9k units across at 200 iterations and 44.7k at 2400, never settling.
 * Because the old code stopped the layout on a five-second timer, the picture
 * you got depended on how many iterations your machine managed in that window.
 * With strong gravity the same vault sits at ~3.4k and stays there.
 *
 * `linLogMode: false` fixes how the graph reads. ForceAtlas2 repulsion scales
 * with (degree+1)² while linLog attraction grows only logarithmically, so the
 * busiest pages were flung to the rim and their leaves left in the middle —
 * the inverse of how a graph should read — and repositories stopped separating
 * (0.88 centroid gap per unit of spread, against 2.88 with linear attraction),
 * which matters because colour is this graph's main channel.
 */
export const WIKI_FA2_SETTINGS = {
  linLogMode: false,
  gravity: 0.05,
  strongGravityMode: true,
  scalingRatio: 50,
  slowDown: 10,
  barnesHutOptimize: true,
  barnesHutTheta: 0.5,
} as const;

/**
 * Noverlap resolves the collisions ForceAtlas2 leaves behind. It only earns
 * its keep now: against the old exploded layout nothing was ever close enough
 * to overlap, so this pass ran in 0ms and did nothing at all.
 */
export const WIKI_NOVERLAP_SETTINGS = { margin: 2, expansion: 1.1 } as const;

/**
 * Enough for the layout to settle, with room to spare — the vault is stable by
 * ~400. Costs roughly 250ms for 377 nodes, paid once on mount instead of five
 * seconds of visible drift.
 */
export const WIKI_LAYOUT_ITERATIONS = 600;

/** Noverlap works on the on-screen footprint, not the raw layout radius. */
export const WIKI_NOVERLAP_SIZE_FACTOR = 8;

/**
 * Lay out a graph in place. The same graph with the same seeded positions
 * gives the same result, verified against the real vault down to the last
 * decimal — which is the property the old wall-clock layout lacked.
 *
 * One caveat: noverlap nudges nodes by a random amount when two of them land
 * exactly on top of each other. Seeded positions are distinct, so this does
 * not arise in practice, but it is the one path that could vary between runs.
 */
export function layoutWikiGraph(
  graph: Graph,
  iterations: number = WIKI_LAYOUT_ITERATIONS,
): void {
  if (graph.order === 0) return;

  forceAtlas2.assign(graph, { iterations, settings: WIKI_FA2_SETTINGS });

  noverlap.assign(graph, {
    maxIterations: 500,
    inputReducer: (_key, attr) => ({
      ...attr,
      size: ((attr.size as number) ?? 4) * WIKI_NOVERLAP_SIZE_FACTOR,
    }),
    settings: WIKI_NOVERLAP_SETTINGS,
  });
}
