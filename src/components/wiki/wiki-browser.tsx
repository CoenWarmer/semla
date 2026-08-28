"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { List, Network, Sparkles } from "lucide-react";
import {
  WikiConfig,
  WikiLink,
  WikiPageMeta,
  WikiRegistry,
  buildTitleMap,
} from "@/lib/wiki-types";
import dynamic from "next/dynamic";
import { WikiNav } from "./wiki-nav";
import { WikiPageView } from "./wiki-page-view";

const WikiGraph = dynamic(
  () => import("./wiki-graph").then((m) => m.WikiGraph),
  { ssr: false, loading: () => <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading graph…</div> },
);
import { cn } from "@/lib/utils";
import { usePendingPrompt } from "@/components/pending-prompt-provider";
import { useUserSettings } from "@/hooks/use-user-settings";

type ViewMode = "list" | "graph";

interface WikiBrowserProps {
  config: WikiConfig | null;
  registry: WikiRegistry | null;
  links: WikiLink[];
  initialPath: string | null;
}

export function WikiBrowser({
  config,
  registry,
  links,
  initialPath,
}: WikiBrowserProps) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [consolidating, setConsolidating] = useState(false);
  const { set: setPendingPrompt } = usePendingPrompt();
  const { data: userSettings } = useUserSettings();

  const handleConsolidate = useCallback(async () => {
    setConsolidating(true);
    try {
      const res = await fetch("/api/sessions", { method: "POST" });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.id) return;

      setPendingPrompt(body.id, {
        goal: null,
        model: {
          modelId: userSettings?.default_model_id ?? "claude-sonnet-4-5",
          provider: userSettings?.default_model_provider ?? "anthropic",
        },
        text: "/consolidate",
        tools: [],
      });

      router.push(`/sessions/${body.id}`);
    } finally {
      setConsolidating(false);
    }
  }, [router, setPendingPrompt, userSettings]);

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

  // Derive per-page backlinks from the flat links list for the "Referenced by" section.
  const backlinks = useMemo(() => {
    const bl: Record<string, string[]> = {};
    for (const { source, target } of links) {
      bl[target] ??= [];
      bl[target].push(source);
    }
    return bl;
  }, [links]);

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
            <button
              onClick={handleConsolidate}
              disabled={consolidating}
              className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
              title="Consolidate wiki"
            >
              <Sparkles className="h-3.5 w-3.5" />
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
            links={links}
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
