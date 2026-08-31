#!/usr/bin/env node
/**
 * Score ForceAtlas2 settings for the /wiki graph across a parameter grid.
 *
 * This is what picked the settings the app now ships. It searches for a
 * configuration that reaches a stable shape inside a fixed iteration budget,
 * then ranks candidates on how the result reads. The layout it replaced never
 * converged — the graph inflated for as long as it ran — which, against a
 * wall-clock cutoff, made the picture depend on how fast the machine was.
 *
 * Columns:
 *   drift    mean node movement from N to 2N iterations, scaled by extent.
 *            Near zero means converged; large means still expanding.
 *   hub      degree↔radius correlation. Negative puts hubs in the middle,
 *            positive is the inverted layout the old settings produced.
 *   screen   p95 radius ÷ max radius. Low means stragglers waste the canvas.
 *   repo     inter-repo centroid gap ÷ mean intra-repo spread. >1 is distinct.
 *   overlap  node pairs closer than the sum of their radii.
 *
 * Usage:
 *   node scripts/wiki-layout-sweep.mjs
 *   node scripts/wiki-layout-sweep.mjs --iterations 400 --top 20
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readWiki, buildGraph, buildRepoColorMap } from "./wiki-layout/graph.mjs";
import { runLayout, APP_FA2, LEGACY_FA2 } from "./wiki-layout/layout.mjs";
import { computeMetrics, drift, fmt } from "./wiki-layout/metrics.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const ITERATIONS = Number(flag("iterations", 600));
const TOP = Number(flag("top", 15));
const SEED = flag("seed", "ring");
const WIKI_HOME = flag("wiki-home", join(REPO_ROOT, ".semla-wiki"));

const GRID = {
  scalingRatio: [1, 2, 5, 10, 20, 50],
  gravity: [0.05, 0.3, 1, 3],
  linLogMode: [true, false],
  strongGravityMode: [false, true],
};

const { pages, links } = readWiki(WIKI_HOME);
const repoColors = buildRepoColorMap(pages);

const combos = [];
for (const scalingRatio of GRID.scalingRatio)
  for (const gravity of GRID.gravity)
    for (const linLogMode of GRID.linLogMode)
      for (const strongGravityMode of GRID.strongGravityMode)
        combos.push({ ...APP_FA2, scalingRatio, gravity, linLogMode, strongGravityMode });

console.log(
  `Sweeping ${combos.length} settings × ${ITERATIONS} iterations ` +
    `(plus a ${ITERATIONS * 2} run each for drift), seed=${SEED}…\n`,
);

const results = [];
for (const fa2 of combos) {
  const g1 = buildGraph(pages, links, repoColors, SEED);
  runLayout(g1, { iterations: ITERATIONS, fa2, noverlapOn: true });

  const g2 = buildGraph(pages, links, repoColors, SEED);
  runLayout(g2, { iterations: ITERATIONS * 2, fa2, noverlapOn: true });

  const m = computeMetrics(g1, pages);
  const d = drift(g1, g2);

  // A layout is good when it has settled (drift), reads right way up (hub),
  // fills the canvas (screen), and separates repos by colour (repo).
  const score =
    Math.max(0, 1 - d) * 3 +
    Math.max(0, -m.hubCentrality) * 2 +
    m.screenUse * 2 +
    Math.min(m.repoSeparation, 2) -
    Math.min(m.overlaps / 100, 2);

  results.push({ fa2, m, drift: d, score });
  process.stdout.write(".");
}
console.log("\n");

const header =
  "  score  drift    hub   screen   repo  overlap  | scaling  gravity  linLog  strongGrav";
console.log(header);
console.log("─".repeat(header.length));

const row = (r) =>
  `${fmt(r.score, 2).padStart(7)} ${fmt(r.drift, 3).padStart(6)} ` +
  `${fmt(r.m.hubCentrality, 3).padStart(6)} ${fmt(r.m.screenUse, 3).padStart(7)} ` +
  `${fmt(r.m.repoSeparation, 2).padStart(6)} ${String(r.m.overlaps).padStart(8)}  | ` +
  `${String(r.fa2.scalingRatio).padStart(7)} ${String(r.fa2.gravity).padStart(8)} ` +
  `${String(r.fa2.linLogMode).padStart(7)} ${String(r.fa2.strongGravityMode).padStart(11)}`;

for (const r of [...results].sort((a, b) => b.score - a.score).slice(0, TOP)) {
  console.log(row(r));
}

const ranked = [...results].sort((a, b) => b.score - a.score);
const find = (want) =>
  results.find(
    (r) =>
      r.fa2.scalingRatio === want.scalingRatio &&
      r.fa2.gravity === want.gravity &&
      r.fa2.linLogMode === want.linLogMode &&
      Boolean(r.fa2.strongGravityMode) === Boolean(want.strongGravityMode),
  );

console.log("─".repeat(header.length));
for (const [label, want] of [
  ["currently shipped", APP_FA2],
  ["before tuning", LEGACY_FA2],
]) {
  const hit = find(want);
  if (hit) {
    console.log(`${row(hit)}   ← ${label} (rank ${ranked.indexOf(hit) + 1}/${results.length})`);
  }
}
