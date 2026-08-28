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
import { navGroupFor, WikiLink, WikiPageMeta, WikiPageType } from "@/lib/wiki-types";

// ─── Colors ──────────────────────────────────────────────────────────────────

const TYPE_COLOR: Record<WikiPageType, string> = {
  entity: "#60a5fa",
  concept: "#a78bfa",
  synthesis: "#fbbf24",
  analysis: "#34d399",
  requirement: "#f87171",
  source: "#94a3b8",
};

const TYPE_SIZE: Record<WikiPageType, number> = {
  entity: 4,
  concept: 4,
  synthesis: 5,
  analysis: 4,
  requirement: 4,
  source: 2,
};

// ─── Graph builder ───────────────────────────────────────────────────────────

function buildGraph(
  pages: Record<string, WikiPageMeta>,
  links: WikiLink[],
): MultiGraph {
  const graph = new MultiGraph();
  const entries = Object.entries(pages);
  const total = entries.length;

  entries.forEach(([path, meta], i) => {
    const angle = (2 * Math.PI * i) / Math.max(total, 1);
    const r = 200;
    graph.addNode(path, {
      label: meta.title,
      x: r * Math.cos(angle),
      y: r * Math.sin(angle),
      size: TYPE_SIZE[meta.type] ?? 6,
      color: TYPE_COLOR[meta.type] ?? "#94a3b8",
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
      gravity: 0.05,
      scalingRatio: 100,
      slowDown: 10,
      barnesHutOptimize: true,
      barnesHutTheta: 0.5,
      // linLogMode uses logarithmic attraction so hub nodes don't collapse
      // their neighbours into a tight ball.
      linLogMode: true,
      // adjustSizes makes FA2 repel nodes based on their size during force
      // computation — essential to avoid overlaps forming in the first place.
      adjustSizes: true,
    },
  });
  const { start: startNoverlap, kill: killNoverlap } = useWorkerLayoutNoverlap({
    settings: { margin: 20, expansion: 1.4 },
  });

  // Run FA2 for 8 s (adjustSizes needs longer to settle), then noverlap for
  // 5 s to sweep up any remaining overlaps.
  useEffect(() => {
    startFA2();
    const fa2Timer = setTimeout(() => {
      killFA2();
      startNoverlap();
      const noverlapTimer = setTimeout(killNoverlap, 5000);
      return () => clearTimeout(noverlapTimer);
    }, 8000);
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
  onNavigate: (path: string) => void;
  onClose: () => void;
}

function ExpandedPanel({ path, meta, onNavigate, onClose }: ExpandedPanelProps) {
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

  return (
    <div className="absolute right-3 top-3 z-20 flex w-80 flex-col rounded-lg border border-border bg-card shadow-lg">
      <div className="flex items-start justify-between gap-2 border-b px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{meta?.title ?? path}</p>
          {meta && (
            <p
              className="mt-0.5 text-[10px]"
              style={{ color: TYPE_COLOR[meta.type] }}
            >
              {navGroup === "observation" ? "observation" : meta.type}
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

const LEGEND_ENTRIES: Array<{ type: WikiPageType; label: string }> = [
  { type: "entity", label: "Entity" },
  { type: "concept", label: "Concept" },
  { type: "synthesis", label: "Synthesis" },
  { type: "analysis", label: "Analysis" },
  { type: "requirement", label: "Requirement" },
  { type: "source", label: "Source" },
];

function Legend() {
  return (
    <div className="absolute bottom-3 left-3 z-10 flex flex-col gap-1 rounded-lg border border-border/60 bg-card/80 px-3 py-2 backdrop-blur-sm">
      {LEGEND_ENTRIES.map(({ type, label }) => (
        <div key={type} className="flex items-center gap-2">
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ background: TYPE_COLOR[type] }}
          />
          <span className="text-[10px] text-muted-foreground">{label}</span>
        </div>
      ))}
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

  const graph = useMemo(() => buildGraph(pages, links), [pages, links]);

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

      <Legend />

      {expandedPath && (
        <ExpandedPanel
          path={expandedPath}
          meta={expandedMeta}
          onNavigate={handleNavigate}
          onClose={() => setExpandedPath(null)}
        />
      )}
    </div>
  );
}
