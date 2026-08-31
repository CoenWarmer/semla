/**
 * Placement metrics for the /wiki graph.
 *
 * These exist to make "the layout looks weird" a measurable claim. Each one
 * targets a specific failure the wiki graph has actually exhibited.
 */

import { repoList } from "./graph.mjs";

export const quantile = (sorted, q) => {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};

export const fmt = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : "–");

/** Pearson correlation, used for the degree↔radius relationship. */
function correlate(xs, ys) {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : 0;
}

export function collectNodes(graph, pages) {
  const nodes = graph.nodes().map((n) => ({
    id: n,
    ...graph.getNodeAttributes(n),
    degree: graph.degree(n),
    repos: repoList(pages[n]),
    type: pages[n].type,
  }));
  const cx = nodes.reduce((a, n) => a + n.x, 0) / nodes.length;
  const cy = nodes.reduce((a, n) => a + n.y, 0) / nodes.length;
  for (const n of nodes) n.radius = Math.hypot(n.x - cx, n.y - cy);
  return { nodes, cx, cy };
}

export function computeMetrics(graph, pages) {
  const { nodes, cx, cy } = collectNodes(graph, pages);
  const xs = nodes.map((n) => n.x);
  const ys = nodes.map((n) => n.y);
  const radii = nodes.map((n) => n.radius).sort((a, b) => a - b);

  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  const diagonal = Math.hypot(width, height);

  // Hubs on the rim. FA2 repulsion scales with (deg+1)², so a high-degree node
  // is pushed outward hardest — the opposite of how a graph should read. A
  // positive correlation means the layout is inverted.
  const hubCentrality = correlate(
    nodes.map((n) => n.degree),
    nodes.map((n) => n.radius),
  );

  // Screen use. Sigma fits the camera to the full extent, so a handful of
  // far-flung nodes shrink everything else into the middle.
  const screenUse = radii.at(-1) ? quantile(radii, 0.95) / radii.at(-1) : 1;

  // Colour is the graph's main channel, so same-repo pages need to land
  // together. Separation > 1 means repos are further apart than they are wide.
  const byRepo = new Map();
  for (const n of nodes) {
    for (const r of n.repos) {
      if (!byRepo.has(r)) byRepo.set(r, []);
      byRepo.get(r).push(n);
    }
  }
  const repoStats = [...byRepo]
    .map(([repo, group]) => {
      const gx = group.reduce((a, n) => a + n.x, 0) / group.length;
      const gy = group.reduce((a, n) => a + n.y, 0) / group.length;
      const spread =
        group.reduce((a, n) => a + Math.hypot(n.x - gx, n.y - gy), 0) / group.length;
      return { repo, n: group.length, gx, gy, spread };
    })
    .sort((a, b) => b.n - a.n);

  const pairDistances = [];
  for (let i = 0; i < repoStats.length; i++) {
    for (let j = i + 1; j < repoStats.length; j++) {
      pairDistances.push({
        a: repoStats[i].repo,
        b: repoStats[j].repo,
        d: Math.hypot(repoStats[i].gx - repoStats[j].gx, repoStats[i].gy - repoStats[j].gy),
      });
    }
  }
  const meanSpread = repoStats.reduce((a, r) => a + r.spread, 0) / (repoStats.length || 1);
  const meanApart = pairDistances.reduce((a, p) => a + p.d, 0) / (pairDistances.length || 1);
  const repoSeparation = meanSpread ? meanApart / meanSpread : 0;

  // Overlap and crowding, in layout units.
  let overlaps = 0;
  let minGap = Infinity;
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const d = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y);
      if (d < nodes[i].size + nodes[j].size) overlaps++;
      if (d < minGap) minGap = d;
    }
  }

  const edgeLengths = [];
  graph.forEachEdge((_e, _a, s, t) => {
    const A = graph.getNodeAttributes(s);
    const B = graph.getNodeAttributes(t);
    edgeLengths.push(Math.hypot(A.x - B.x, A.y - B.y));
  });
  edgeLengths.sort((a, b) => a - b);

  const degrees = nodes.map((n) => n.degree).sort((a, b) => a - b);

  return {
    nodes, cx, cy, width, height, diagonal, radii, degrees,
    hubCentrality, screenUse, repoStats, pairDistances, repoSeparation,
    overlaps, minGap, edgeLengths,
    isolated: nodes.filter((n) => n.degree === 0).length,
    edges: graph.size,
  };
}

/**
 * Mean node displacement between two layouts of the same graph, scaled by
 * extent. A converged layout barely moves when given twice the iterations;
 * the current settings keep inflating, which is why what you see depends on
 * how fast your machine is.
 */
export function drift(graphA, graphB) {
  const norm = (g) => {
    const nodes = g.nodes().map((n) => g.getNodeAttributes(n));
    const cx = nodes.reduce((a, n) => a + n.x, 0) / nodes.length;
    const cy = nodes.reduce((a, n) => a + n.y, 0) / nodes.length;
    const scale =
      nodes.reduce((a, n) => a + Math.hypot(n.x - cx, n.y - cy), 0) / nodes.length;
    return { cx, cy, scale: scale || 1 };
  };
  const A = norm(graphA);
  const B = norm(graphB);

  const pairs = [];
  for (const key of graphA.nodes()) {
    if (!graphB.hasNode(key)) continue;
    const a = graphA.getNodeAttributes(key);
    const b = graphB.getNodeAttributes(key);
    pairs.push([
      (a.x - A.cx) / A.scale, (a.y - A.cy) / A.scale,
      (b.x - B.cx) / B.scale, (b.y - B.cy) / B.scale,
    ]);
  }
  if (pairs.length === 0) return 0;

  // Procrustes: rotate B onto A first. A force layout is free to spin as a
  // rigid whole while holding its shape, and that spin is not drift.
  let cross = 0;
  let dot = 0;
  for (const [ax, ay, bx, by] of pairs) {
    cross += ax * by - ay * bx;
    dot += ax * bx + ay * by;
  }
  const theta = Math.atan2(cross, dot);
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);

  let total = 0;
  for (const [ax, ay, bx, by] of pairs) {
    total += Math.hypot(ax - (bx * cos + by * sin), ay - (-bx * sin + by * cos));
  }
  return total / pairs.length;
}

export function formatReport(m, header) {
  const L = [];
  const rule = (t) => `\n─── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`;

  L.push(rule("Input"));
  for (const [k, v] of Object.entries(header)) L.push(`${k.padEnd(16)}${v}`);
  L.push(`pages           ${m.nodes.length}`);
  L.push(`edges           ${m.edges}`);

  L.push(rule("Placement"));
  L.push(`extent          ${fmt(m.width)} × ${fmt(m.height)}   diagonal ${fmt(m.diagonal)}`);
  L.push(`radius p50/p95  ${fmt(quantile(m.radii, 0.5))} / ${fmt(quantile(m.radii, 0.95))}` +
    `   max ${fmt(m.radii.at(-1))}`);
  L.push(`screen use      ${fmt(m.screenUse, 3)}   (p95 radius ÷ max; 1.0 = no stragglers)`);
  L.push(`hub centrality  ${fmt(m.hubCentrality, 3)}   (degree↔radius; <0 hubs central, >0 inverted)`);

  L.push(rule("Spacing"));
  L.push(`overlapping     ${m.overlaps} pairs`);
  L.push(`closest pair    ${fmt(m.minGap)} units`);
  L.push(`edge len p10/50/90  ${fmt(quantile(m.edgeLengths, 0.1))} / ` +
    `${fmt(quantile(m.edgeLengths, 0.5))} / ${fmt(quantile(m.edgeLengths, 0.9))}`);

  L.push(rule("Repo clustering"));
  L.push(`separation      ${fmt(m.repoSeparation, 2)}   (mean centroid gap ÷ mean spread; >1 is distinct)`);
  for (const r of m.repoStats) {
    L.push(`${r.repo.padEnd(20)} n=${String(r.n).padStart(4)}  ` +
      `centroid (${fmt(r.gx).padStart(8)}, ${fmt(r.gy).padStart(8)})  spread ${fmt(r.spread)}`);
  }
  for (const p of m.pairDistances) {
    L.push(`  ${p.a} ↔ ${p.b}: ${fmt(p.d)}`);
  }

  L.push(rule("Top hubs"));
  for (const n of [...m.nodes].sort((a, b) => b.degree - a.degree).slice(0, 10)) {
    L.push(`${String(n.degree).padStart(4)}  ${n.type.padEnd(13)} r=${fmt(n.radius).padStart(9)}  ${n.label}`);
  }

  return L.join("\n");
}
