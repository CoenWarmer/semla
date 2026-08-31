#!/usr/bin/env node
/**
 * Reproduce the /wiki graph layout headlessly, so node placement can be
 * inspected as data rather than guessed at from a screenshot.
 *
 * Emits a coordinate dump, a labelled render, and placement metrics. Pair it
 * with wiki-layout-sweep.mjs, which scores many settings at once.
 *
 * Usage:
 *   node scripts/wiki-layout-probe.mjs
 *   node scripts/wiki-layout-probe.mjs --iterations 2000 --scaling 10
 *   node scripts/wiki-layout-probe.mjs --crop -3000,-3000,3000,3000 --labels all
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readWiki, buildGraph, buildRepoColorMap } from "./wiki-layout/graph.mjs";
import { runLayout, APP_FA2, APP_NOVERLAP } from "./wiki-layout/layout.mjs";
import { computeMetrics, formatReport } from "./wiki-layout/metrics.mjs";
import { renderSvg, rasterize } from "./wiki-layout/render.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

const OPTS = {
  wikiHome: flag("wiki-home", join(REPO_ROOT, ".semla-wiki")),
  outDir: flag("out", join(REPO_ROOT, ".semla-debug", "wiki-layout")),
  iterations: Number(flag("iterations", 600)),
  seed: flag("seed", "ring"),
  size: Number(flag("size", 2000)),
  labels: flag("labels", "hubs"),
  crop: flag("crop", null),
};

/** Flags override the shipped settings; anything unflagged stays as shipped. */
const toggle = (name, shipped) =>
  has(name) ? true : has(`no-${name}`) ? false : shipped;

const fa2 = {
  ...APP_FA2,
  linLogMode: toggle("linlog", APP_FA2.linLogMode),
  strongGravityMode: toggle("strong-gravity", APP_FA2.strongGravityMode),
  gravity: Number(flag("gravity", APP_FA2.gravity)),
  scalingRatio: Number(flag("scaling", APP_FA2.scalingRatio)),
  slowDown: Number(flag("slowdown", APP_FA2.slowDown)),
  outboundAttractionDistribution: has("outbound"),
  adjustSizes: has("adjust-sizes"),
};

const { pages, links } = readWiki(OPTS.wikiHome);
const repoColors = buildRepoColorMap(pages);
const graph = buildGraph(pages, links, repoColors, OPTS.seed);

const noverlapOn = !has("no-noverlap");
const timing = runLayout(graph, { iterations: OPTS.iterations, fa2, noverlapOn });

const m = computeMetrics(graph, pages);
const rate = OPTS.iterations / (timing.fa2Ms / 1000 || 1);

console.log(
  formatReport(m, {
    layout: `FA2 ${OPTS.iterations} iters${noverlapOn ? " + noverlap" : " (noverlap off)"}` +
      `  [${timing.fa2Ms}ms / ${timing.noverlapMs}ms]`,
    settings: `scaling ${fa2.scalingRatio}  gravity ${fa2.gravity}` +
      `  linLog ${fa2.linLogMode}  slowDown ${fa2.slowDown}` +
      (fa2.strongGravityMode ? "  strongGravity" : "") +
      (fa2.outboundAttractionDistribution ? "  outbound" : ""),
    seed: OPTS.seed,
    "app equiv": `5s worker ≈ ${Math.round(rate * 5)} iters at this machine's rate`,
  }),
);

mkdirSync(OPTS.outDir, { recursive: true });

const jsonPath = join(OPTS.outDir, "layout.json");
writeFileSync(
  jsonPath,
  JSON.stringify(
    {
      generated: new Date().toISOString(),
      params: { ...OPTS, fa2, noverlap: noverlapOn ? APP_NOVERLAP : null },
      edges: m.edges,
      nodes: m.nodes.map(({ id, label, type, repos, degree, x, y, size, color, radius }) => ({
        id, label, type, repos, degree,
        x: Number(x.toFixed(2)), y: Number(y.toFixed(2)),
        size, color, radius: Number(radius.toFixed(2)),
      })),
    },
    null,
    2,
  ),
);

const svgPath = join(OPTS.outDir, "layout.svg");
writeFileSync(
  svgPath,
  renderSvg(graph, m.nodes, {
    size: OPTS.size,
    labels: OPTS.labels,
    crop: OPTS.crop,
    caption: `${m.nodes.length} nodes · FA2 ${OPTS.iterations} · scaling ${fa2.scalingRatio}` +
      ` · gravity ${fa2.gravity}${fa2.linLogMode ? " · linLog" : ""}`,
  }),
);

const png = rasterize(svgPath, join(OPTS.outDir, "layout.png"));

console.log(`\n─── Written ${"─".repeat(48)}`);
console.log(`  ${jsonPath}\n  ${svgPath}`);
console.log(png ? `  ${png}\n` : `  (png skipped: ImageMagick unavailable)\n`);
