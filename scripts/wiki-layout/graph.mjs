/**
 * Rebuilds the /wiki graph's inputs outside the browser.
 *
 * Everything here mirrors code that runs in the app — src/lib/wiki.ts,
 * src/lib/wiki-types.ts and src/components/wiki/wiki-graph.tsx. Keep it in
 * step with them, or the probe stops describing what users actually see.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MultiGraph } from "graphology";

// ─── Mirrors src/lib/wiki-types.ts ───────────────────────────────────────────

export const repoList = (meta) => {
  if (!meta.repo) return [];
  const raw = Array.isArray(meta.repo) ? meta.repo : [meta.repo];
  return [...new Set(raw)].sort();
};

const extractWikiLinks = (content) =>
  [...content.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]);

// ─── Mirrors src/components/wiki/wiki-graph.tsx ──────────────────────────────

export const TYPE_SIZE = {
  repository: 7, person: 5, organisation: 5, entity: 5, concept: 4,
  synthesis: 5, analysis: 4, requirement: 4, source: 2,
};

const REPO_PALETTE = [
  "#60a5fa", "#34d399", "#fbbf24", "#fb923c",
  "#f472b6", "#a78bfa", "#38bdf8", "#4ade80",
];
export const SHARED_COLOR = "#22d3ee";
export const UNKNOWN_COLOR = "#475569";

export const buildRepoColorMap = (pages) => {
  const repos = [...new Set(Object.values(pages).flatMap(repoList))].sort();
  const map = new Map();
  repos.forEach((r, i) => map.set(r, REPO_PALETTE[i % REPO_PALETTE.length]));
  return map;
};

export const nodeColor = (meta, repoColors) => {
  const repos = repoList(meta);
  if (repos.length === 0) return UNKNOWN_COLOR;
  if (repos.length === 1) return repoColors.get(repos[0]) ?? UNKNOWN_COLOR;
  return SHARED_COLOR;
};

// ─── Mirrors src/lib/wiki.ts ─────────────────────────────────────────────────

const stripFrontmatter = (content) => {
  if (!content.startsWith("---")) return content;
  const end = content.indexOf("\n---", 3);
  return end === -1 ? content : content.slice(end + 4).trimStart();
};

export function readWiki(wikiHome) {
  const root = join(wikiHome, ".llm-wiki");
  const registryPath = join(root, "meta", "registry.json");
  if (!existsSync(registryPath)) {
    throw new Error(`No registry at ${registryPath}. Pass --wiki-home.`);
  }
  const registry = JSON.parse(readFileSync(registryPath, "utf-8"));
  const wikiDir = join(root, "wiki");

  const pageContent = (pagePath) => {
    const normalized = pagePath.replace(/\.\./g, "").replace(/^\/+/, "");
    const full = join(wikiDir, normalized + ".md");
    return existsSync(full) ? stripFrontmatter(readFileSync(full, "utf-8")) : null;
  };

  const pages = registry.pages;
  const titleToPath = {};
  for (const [path, meta] of Object.entries(pages)) titleToPath[meta.title] = path;

  const links = [];
  for (const path of Object.keys(pages)) {
    const content = pageContent(path);
    if (!content) continue;
    const seen = new Set();
    const add = (target) => {
      if (target && target !== path && !seen.has(target)) {
        seen.add(target);
        links.push({ source: path, target });
      }
    };
    for (const raw of extractWikiLinks(content)) {
      const target = pages[raw] ? raw : titleToPath[raw];
      if (target) add(target);
    }
    const mdRe =
      /\((\/?(?:entities|concepts|sources|syntheses|analyses|requirements)[^)]+\.md)\)/g;
    for (const match of content.matchAll(mdRe)) {
      const mdPath = match[1].replace(/^\//, "").replace(/\.md$/, "");
      if (pages[mdPath]) add(mdPath);
    }
  }

  return { registry, pages, links };
}

/**
 * Identical to buildGraph() in wiki-graph.tsx.
 *
 * `seed` selects the initial placement: "ring" is what the app does today
 * (every node on a circle of r=200, ordered by registry key), "random" is the
 * usual force-layout starting point. Seeding matters — a deterministic layout
 * inherits whatever bias the seed has.
 */
export function buildGraph(pages, links, repoColors, seed = "ring") {
  const graph = new MultiGraph();
  const entries = Object.entries(pages);
  const total = entries.length;

  // Deterministic PRNG so a "random" seed still reproduces exactly.
  let state = 42;
  const rand = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };

  entries.forEach(([path, meta], i) => {
    let x, y;
    if (seed === "random") {
      const angle = rand() * 2 * Math.PI;
      const r = Math.sqrt(rand()) * 200;
      x = r * Math.cos(angle);
      y = r * Math.sin(angle);
    } else {
      const angle = (2 * Math.PI * i) / Math.max(total, 1);
      x = 200 * Math.cos(angle);
      y = 200 * Math.sin(angle);
    }
    graph.addNode(path, {
      label: meta.title,
      x,
      y,
      size: TYPE_SIZE[meta.type] ?? 4,
      color: nodeColor(meta, repoColors),
      type: "circle",
    });
  });

  for (const { source, target } of links) {
    if (graph.hasNode(source) && graph.hasNode(target) && source !== target) {
      try {
        graph.addEdge(source, target, { size: 1, color: "#334155" });
      } catch {
        // duplicate edge in MultiGraph
      }
    }
  }
  return graph;
}
