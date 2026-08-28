"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MultiGraph } from "graphology";
import {
  SigmaContainer,
  useCamera,
  useRegisterEvents,
  useSetSettings,
} from "@react-sigma/core";
import { useWorkerLayoutForceAtlas2 } from "@react-sigma/layout-forceatlas2";
import { useWorkerLayoutNoverlap } from "@react-sigma/layout-noverlap";
import { useQuery } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { X, ZoomIn, ZoomOut, Maximize2 } from "lucide-react";
import { navGroupFor, repoList, WikiLink, WikiPageMeta, WikiPageType } from "@/lib/wiki-types";

// ─── Colors ──────────────────────────────────────────────────────────────────

// Node size still encodes page type so shape information is preserved.
const TYPE_SIZE: Record<WikiPageType, number> = {
  entity: 5,
  concept: 4,
  synthesis: 5,
  analysis: 4,
  requirement: 4,
  source: 2,
};

// Ordered palette for repo assignment (dark-background-friendly, distinct hues).
const REPO_PALETTE = [
  "#60a5fa", // blue
  "#34d399", // emerald
  "#fbbf24", // amber
  "#fb923c", // orange
  "#f472b6", // pink
  "#a78bfa", // violet
  "#38bdf8", // sky
  "#4ade80", // green
];
// Nodes that belong to exactly one repo get that repo's color.
// Nodes that belong to multiple repos get this shared color.
const SHARED_COLOR = "#22d3ee";  // cyan — visually distinct from all palette entries
const UNKNOWN_COLOR = "#475569"; // slate — no repo field at all

/** Derive a stable repo→color mapping from the pages actually present. */
function buildRepoColorMap(pages: Record<string, WikiPageMeta>): Map<string, string> {
  const repos = Array.from(
    new Set(Object.values(pages).flatMap((m) => repoList(m))),
  ).sort();
  const map = new Map<string, string>();
  repos.forEach((repo, i) => map.set(repo, REPO_PALETTE[i % REPO_PALETTE.length]!));
  return map;
}

/** Pick the node color: repo color, shared, or unknown. */
function nodeColor(meta: WikiPageMeta, repoColors: Map<string, string>): string {
  const repos = repoList(meta);
  if (repos.length === 0) return UNKNOWN_COLOR;
  if (repos.length === 1) return repoColors.get(repos[0]!) ?? UNKNOWN_COLOR;
  return SHARED_COLOR;
}

// ─── Graph builder ───────────────────────────────────────────────────────────

function buildGraph(
  pages: Record<string, WikiPageMeta>,
  links: WikiLink[],
  repoColors: Map<string, string>,
): MultiGraph {
  const graph = new MultiGraph();
  const entries = Object.entries(pages);
  const total = entries.length;

  entries.forEach(([path, meta], i) => {
    const angle = (2 * Math.PI * i) / Math.max(total, 1);
    const r = 200;
    const color = nodeColor(meta, repoColors);
    graph.addNode(path, {
      label: meta.title,
      x: r * Math.cos(angle),
      y: r * Math.sin(angle),
      size: TYPE_SIZE[meta.type] ?? 4,
      color,
      type: "circle",
    });
  });

  for (const { source, target } of links) {
    if (graph.hasNode(source) && graph.hasNode(target) && source !== target) {
      try {
        graph.addEdge(source, target, {
          size: 1,
          color: "#334155",
        });
      } catch {
        // ignore duplicate edges in MultiGraph
      }
    }
  }

  return graph;
}

// ─── Inner controller (must be inside SigmaContainer) ────────────────────────

interface GraphControllerProps {
  selectedPath: string | null;
  expandedPath: string | null;
  onNodeClick: (path: string) => void;
}

function GraphController({ selectedPath, expandedPath, onNodeClick }: GraphControllerProps) {
  const registerEvents = useRegisterEvents();
  const setSettings = useSetSettings();
  const { zoomIn, zoomOut, reset } = useCamera({ duration: 200 });
  const { start: startFA2, kill: killFA2 } = useWorkerLayoutForceAtlas2({
    settings: {
      // linLogMode weakens attraction inside dense clusters so source nodes
      // don't pile on top of their hub. Higher gravity (0.3) keeps the overall
      // graph from flying apart into a ring.
      linLogMode: true,
      gravity: 0.3,
      scalingRatio: 50,
      slowDown: 10,
      barnesHutOptimize: true,
      barnesHutTheta: 0.5,
    },
  });
  const killNoverlapRef = useRef<(() => void) | null>(null);
  const { start: startNoverlap, kill: killNoverlap } = useWorkerLayoutNoverlap({
    // inputReducer inflates the node size so noverlap's collision detection
    // matches the actual visual footprint in screen pixels.
    inputReducer: (_key, attr) => ({ ...attr, size: (attr.size ?? 4) * 8 }),
    settings: { margin: 2, expansion: 1.1 },
    onConverged: () => killNoverlapRef.current?.(),
  });

  useEffect(() => {
    killNoverlapRef.current = killNoverlap;
  }, [killNoverlap]);

  // FA2 runs for 5 s to establish cluster structure; noverlap then runs
  // until it converges (or 10 s safety timeout).
  useEffect(() => {
    startFA2();
    const fa2Timer = setTimeout(() => {
      killFA2();
      startNoverlap();
      const safetyTimer = setTimeout(killNoverlap, 10_000);
      return () => clearTimeout(safetyTimer);
    }, 5000);
    return () => {
      clearTimeout(fa2Timer);
      killFA2();
      killNoverlap();
    };
  }, [startFA2, killFA2, startNoverlap, killNoverlap]);

  // Keep a ref to selected/expanded so the node reducer stays current without
  // recreating sigma (useSetSettings is stable).
  const stateRef = useRef({ selectedPath, expandedPath });
  useEffect(() => {
    stateRef.current = { selectedPath, expandedPath };
  }, [selectedPath, expandedPath]);

  // Update nodeReducer whenever highlight state changes.
  useEffect(() => {
    setSettings({
      nodeReducer: (node, data) => {
        const { selectedPath: sel, expandedPath: exp } = stateRef.current;
        const isActive = node === sel || node === exp;
        return {
          ...data,
          color: isActive ? "#f8fafc" : data.color,
          size: isActive ? (data.size as number) + 2 : data.size,
          zIndex: isActive ? 1 : 0,
        };
      },
      edgeReducer: (_edge, data) => ({ ...data, hidden: false }),
    });
  }, [selectedPath, expandedPath, setSettings]);

  // Register click events.
  useEffect(() => {
    registerEvents({
      clickNode: ({ node }) => onNodeClick(node),
      clickStage: () => onNodeClick(""),
    });
  }, [registerEvents, onNodeClick]);

  return (
    <div className="absolute bottom-3 right-3 flex flex-col gap-1 z-10">
      <button
        onClick={() => zoomIn()}
        className="flex h-7 w-7 items-center justify-center rounded border border-border/60 bg-card text-muted-foreground hover:text-foreground transition-colors"
        title="Zoom in"
      >
        <ZoomIn className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={() => zoomOut()}
        className="flex h-7 w-7 items-center justify-center rounded border border-border/60 bg-card text-muted-foreground hover:text-foreground transition-colors"
        title="Zoom out"
      >
        <ZoomOut className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={() => reset()}
        className="flex h-7 w-7 items-center justify-center rounded border border-border/60 bg-card text-muted-foreground hover:text-foreground transition-colors"
        title="Fit view"
      >
        <Maximize2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// ─── Expanded page panel ──────────────────────────────────────────────────────

interface ExpandedPanelProps {
  path: string;
  meta: WikiPageMeta | undefined;
  repoColors: Map<string, string>;
  onNavigate: (path: string) => void;
  onClose: () => void;
}

function ExpandedPanel({ path, meta, repoColors, onNavigate, onClose }: ExpandedPanelProps) {
  const query = useQuery<{ content: string }>({
    queryKey: ["wiki-page", path],
    queryFn: async () => {
      const res = await fetch(`/api/wiki/page?path=${encodeURIComponent(path)}`);
      if (!res.ok) throw new Error(`Failed to load page (${res.status})`);
      return res.json() as Promise<{ content: string }>;
    },
    staleTime: Infinity,
  });

  const content = query.data?.content?.replace(/^---[\s\S]*?---\n*/m, "").trim();
  const navGroup = meta ? navGroupFor(meta) : null;
  const repos = meta ? repoList(meta) : [];
  const color = meta ? nodeColor(meta, repoColors) : UNKNOWN_COLOR;
  const repoLabel = repos.length === 0 ? null : repos.join(", ");

  return (
    <div className="absolute right-3 top-3 z-20 flex w-80 flex-col rounded-lg border border-border bg-card shadow-lg">
      <div className="flex items-start justify-between gap-2 border-b px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{meta?.title ?? path}</p>
          {meta && (
            <p className="mt-0.5 text-[10px]" style={{ color }}>
              {repoLabel
                ? `${repoLabel} · ${navGroup === "observation" ? "observation" : meta.type}`
                : (navGroup === "observation" ? "observation" : meta.type)}
            </p>
          )}
        </div>
        <button
          onClick={onClose}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="max-h-72 overflow-y-auto px-4 py-3">
        {query.isPending && (
          <p className="text-xs text-muted-foreground">Loading…</p>
        )}
        {query.isError && (
          <p className="text-xs text-destructive">Could not load page.</p>
        )}
        {content && (
          <div className="prose prose-xs prose-invert max-w-none [&_*]:text-[11px] [&_h1]:text-xs [&_h2]:text-xs [&_h3]:text-xs">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
          </div>
        )}
      </div>

      <div className="border-t px-4 py-2.5">
        <button
          onClick={() => onNavigate(path)}
          className="text-xs text-blue-400 hover:underline underline-offset-2"
        >
          Open full page →
        </button>
      </div>
    </div>
  );
}

// ─── Legend ──────────────────────────────────────────────────────────────────

interface LegendProps {
  repoColors: Map<string, string>;
  hasShared: boolean;
  hasUnknown: boolean;
}

function Legend({ repoColors, hasShared, hasUnknown }: LegendProps) {
  const repoEntries = Array.from(repoColors.entries());
  return (
    <div className="absolute bottom-3 left-3 z-10 flex flex-col gap-1 rounded-lg border border-border/60 bg-card/80 px-3 py-2 backdrop-blur-sm">
      <p className="mb-0.5 text-[9px] font-medium uppercase tracking-wider text-muted-foreground/60">
        Repository
      </p>
      {repoEntries.map(([repo, color]) => (
        <div key={repo} className="flex items-center gap-2">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
          <span className="text-[10px] text-muted-foreground">{repo}</span>
        </div>
      ))}
      {hasShared && (
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: SHARED_COLOR }} />
          <span className="text-[10px] text-muted-foreground">shared</span>
        </div>
      )}
      {hasUnknown && (
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: UNKNOWN_COLOR }} />
          <span className="text-[10px] text-muted-foreground/60">unknown</span>
        </div>
      )}
    </div>
  );
}

// ─── Public component ─────────────────────────────────────────────────────────

interface WikiGraphProps {
  pages: Record<string, WikiPageMeta>;
  links: WikiLink[];
  selectedPath: string | null;
  onNavigate: (path: string) => void;
}

export function WikiGraph({ pages, links, selectedPath, onNavigate }: WikiGraphProps) {
  const [expandedPath, setExpandedPath] = useState<string | null>(null);

  const repoColors = useMemo(() => buildRepoColorMap(pages), [pages]);
  const graph = useMemo(() => buildGraph(pages, links, repoColors), [pages, links, repoColors]);

  const { hasShared, hasUnknown } = useMemo(() => {
    let shared = false, unknown = false;
    for (const meta of Object.values(pages)) {
      const repos = repoList(meta);
      if (repos.length === 0) unknown = true;
      else if (repos.length > 1) shared = true;
      if (shared && unknown) break;
    }
    return { hasShared: shared, hasUnknown: unknown };
  }, [pages]);

  const handleNodeClick = useCallback((path: string) => {
    setExpandedPath(path || null);
  }, []);

  const handleNavigate = useCallback(
    (path: string) => {
      setExpandedPath(null);
      onNavigate(path);
    },
    [onNavigate],
  );

  const expandedMeta = expandedPath ? pages[expandedPath] : undefined;

  return (
    <div className="relative h-full w-full overflow-hidden bg-background">
      <SigmaContainer
        graph={graph}
        settings={{
          defaultNodeType: "circle",
          defaultEdgeType: "arrow",
          renderEdgeLabels: false,
          labelFont: "Inter, sans-serif",
          labelSize: 11,
          labelWeight: "400",
          labelColor: { color: "#94a3b8" },
          defaultEdgeColor: "#334155",
          minCameraRatio: 0.05,
          maxCameraRatio: 4,
        }}
        className="h-full w-full"
        style={{ background: "transparent" }}
      >
        <GraphController
          selectedPath={selectedPath}
          expandedPath={expandedPath}
          onNodeClick={handleNodeClick}
        />
      </SigmaContainer>

      <Legend repoColors={repoColors} hasShared={hasShared} hasUnknown={hasUnknown} />

      {expandedPath && (
        <ExpandedPanel
          path={expandedPath}
          meta={expandedMeta}
          repoColors={repoColors}
          onNavigate={handleNavigate}
          onClose={() => setExpandedPath(null)}
        />
      )}
    </div>
  );
}
