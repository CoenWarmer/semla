"use client";

import { useEffect, useMemo } from "react";
import { SigmaContainer } from "@react-sigma/core";
import { useWorkerLayoutForceAtlas2 } from "@react-sigma/layout-forceatlas2";
import { useQuery } from "@tanstack/react-query";
import { buildGraph, buildRepoColorMap } from "./wiki-graph";
import type { WikiLink, WikiPageMeta } from "@/lib/wiki-types";

// ─── Inner layout controller (must live inside SigmaContainer) ───────────────

function MiniGraphLayout() {
  const { start, kill } = useWorkerLayoutForceAtlas2({
    settings: {
      linLogMode: true,
      gravity: 0.3,
      scalingRatio: 50,
      slowDown: 10,
      barnesHutOptimize: true,
      barnesHutTheta: 0.5,
    },
  });

  useEffect(() => {
    start();
    const timer = setTimeout(() => kill(), 4000);
    return () => {
      clearTimeout(timer);
      kill();
    };
  }, [start, kill]);

  return null;
}

// ─── API response type ────────────────────────────────────────────────────────

interface WikiApiResponse {
  initialized: boolean;
  registry: { pages: Record<string, WikiPageMeta> } | null;
  links: WikiLink[];
}

// ─── Public component ─────────────────────────────────────────────────────────

export function WikiMiniGraph() {
  const query = useQuery<WikiApiResponse>({
    queryKey: ["wiki"],
    queryFn: async () => {
      const res = await fetch("/api/wiki");
      if (!res.ok) throw new Error(`wiki ${res.status}`);
      return res.json() as Promise<WikiApiResponse>;
    },
    refetchInterval: 4000,
    staleTime: 0,
  });

  const nodeCount = Object.keys(query.data?.registry?.pages ?? {}).length;

  const repoColors = useMemo(
    () => buildRepoColorMap(query.data?.registry?.pages ?? {}),
    [query.data],
  );
  const graph = useMemo(
    () =>
      buildGraph(
        query.data?.registry?.pages ?? {},
        query.data?.links ?? [],
        repoColors,
      ),
    [query.data, repoColors],
  );

  return (
    <div
      className="fixed bottom-6 right-6 z-50 flex flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl"
      style={{ width: 250, height: 170 }}
    >
      <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Wiki
        </span>
        <span className="text-[10px] tabular-nums text-muted-foreground/60">
          {nodeCount} {nodeCount === 1 ? "page" : "pages"}
        </span>
      </div>

      <div className="relative min-h-0 flex-1">
        {nodeCount === 0 ? (
          <div className="flex h-full items-center justify-center">
            <span className="text-[10px] text-muted-foreground">
              Initialising…
            </span>
          </div>
        ) : (
          // Key on nodeCount so Sigma remounts (and layout restarts) when pages are added.
          <SigmaContainer
            key={nodeCount}
            graph={graph}
            settings={{
              defaultNodeType: "circle",
              defaultEdgeType: "arrow",
              renderEdgeLabels: false,
              // Suppress labels — too cluttered at this size.
              labelRenderedSizeThreshold: 999,
              defaultEdgeColor: "#334155",
              minCameraRatio: 0.05,
              maxCameraRatio: 4,
            }}
            className="h-full w-full"
            style={{ background: "transparent" }}
          >
            <MiniGraphLayout />
          </SigmaContainer>
        )}
      </div>
    </div>
  );
}
