/**
 * The layout the /wiki graph runs, as a single reusable call.
 *
 * The app runs ForceAtlas2 in a worker for a fixed 5 seconds and then
 * Noverlap. Both ship synchronous variants taking the same settings, so the
 * whole pipeline reproduces here — with an iteration count instead of a wall
 * clock, which is the only way to compare two settings fairly.
 */

import forceAtlas2 from "graphology-layout-forceatlas2";
import noverlap from "graphology-layout-noverlap";

/**
 * Settings currently shipped, mirroring WIKI_FA2_SETTINGS in
 * src/lib/wiki-graph-layout.ts. Keep the two in step.
 */
export const APP_FA2 = {
  linLogMode: false,
  gravity: 0.05,
  strongGravityMode: true,
  scalingRatio: 50,
  slowDown: 10,
  barnesHutOptimize: true,
  barnesHutTheta: 0.5,
};

/**
 * What shipped before the tuning pass, kept so the sweep can show the contrast.
 * Inflated without bound (13.9k units across at 200 iterations, 44.7k at 2400)
 * and put the busiest pages on the rim.
 */
export const LEGACY_FA2 = {
  linLogMode: true,
  gravity: 0.3,
  scalingRatio: 50,
  slowDown: 10,
  barnesHutOptimize: true,
  barnesHutTheta: 0.5,
};

export const APP_NOVERLAP = { margin: 2, expansion: 1.1 };

/** Noverlap inflates node size so collision matches the on-screen footprint. */
export const NOVERLAP_INPUT_REDUCER = (_key, attr) => ({
  ...attr,
  size: (attr.size ?? 4) * 8,
});

export function runLayout(graph, { iterations = 600, fa2 = APP_FA2, noverlapOn = true, noverlapSettings = APP_NOVERLAP } = {}) {
  const t0 = Date.now();
  forceAtlas2.assign(graph, { iterations, settings: fa2 });
  const fa2Ms = Date.now() - t0;

  const t1 = Date.now();
  if (noverlapOn) {
    noverlap.assign(graph, {
      maxIterations: 500,
      inputReducer: NOVERLAP_INPUT_REDUCER,
      settings: noverlapSettings,
    });
  }
  return { fa2Ms, noverlapMs: Date.now() - t1 };
}
