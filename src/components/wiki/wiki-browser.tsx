"use client";

import { useCallback, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { List, Network } from "lucide-react";
import {
  WikiConfig,
  WikiPageMeta,
  WikiRegistry,
  buildTitleMap,
} from "@/lib/wiki-types";
import { WikiNav } from "./wiki-nav";
import { WikiPageView } from "./wiki-page-view";
import { WikiGraph } from "./wiki-graph";
import { cn } from "@/lib/utils";

type ViewMode = "list" | "graph";

interface WikiBrowserProps {
  config: WikiConfig | null;
  registry: WikiRegistry | null;
  backlinks: Record<string, string[]>;
  initialPath: string | null;
}

export function WikiBrowser({
  config,
  registry,
  backlinks,
  initialPath,
}: WikiBrowserProps) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [viewMode, setViewMode] = useState<ViewMode>("list");

  const selectedPath = searchParams.get("page") ?? initialPath;
  const pages = registry?.pages ?? {};
  const titleToPath = registry ? buildTitleMap(registry) : {};

  const navigate = useCallback(
    (path: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("page", path);
      router.push(`/wiki?${params.toString()}`);
    },
    [router, searchParams],
  );

  const selectedMeta: WikiPageMeta | undefined = selectedPath
    ? pages[selectedPath]
    : undefined;

  const selectedBacklinks = selectedPath ? (backlinks[selectedPath] ?? []) : [];

  const title =
    config?.name && config.name !== "pending" ? config.name : "Wiki";

  return (
    <div className="flex h-full overflow-hidden">
      <aside className="flex w-56 shrink-0 flex-col overflow-y-auto border-r">
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <p className="font-heading text-sm font-semibold">{title}</p>
          <div className="flex items-center gap-0.5">
            <button
              onClick={() => setViewMode("list")}
              className={cn(
                "rounded p-1 transition-colors",
                viewMode === "list"
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              title="List view"
            >
              <List className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => setViewMode("graph")}
              className={cn(
                "rounded p-1 transition-colors",
                viewMode === "graph"
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              title="Graph view"
            >
              <Network className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        {registry ? (
          <WikiNav
            pages={pages}
            selectedPath={selectedPath}
            onSelect={navigate}
          />
        ) : (
          <p className="p-4 text-xs text-muted-foreground">
            No pages indexed yet.
          </p>
        )}
      </aside>

      <main className="flex-1 overflow-hidden">
        {viewMode === "graph" ? (
          <WikiGraph
            pages={pages}
            backlinks={backlinks}
            selectedPath={selectedPath}
            onNavigate={(path) => {
              navigate(path);
              setViewMode("list");
            }}
          />
        ) : selectedPath ? (
          <div className="h-full overflow-y-auto">
            <WikiPageView
              path={selectedPath}
              meta={selectedMeta}
              pages={pages}
              titleToPath={titleToPath}
              backlinkPaths={selectedBacklinks}
              onNavigate={navigate}
            />
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Select a page from the navigation.
          </div>
        )}
      </main>
    </div>
  );
}
