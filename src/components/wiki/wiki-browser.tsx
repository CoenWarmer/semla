"use client";

import { useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  WikiConfig,
  WikiPageMeta,
  WikiRegistry,
  buildTitleMap,
} from "@/lib/wiki-types";
import { WikiNav } from "./wiki-nav";
import { WikiPageView } from "./wiki-page-view";

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
        <div className="border-b px-4 py-3">
          <p className="font-heading text-sm font-semibold">{title}</p>
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

      <main className="flex-1 overflow-y-auto">
        {selectedPath ? (
          <WikiPageView
            path={selectedPath}
            meta={selectedMeta}
            pages={pages}
            titleToPath={titleToPath}
            backlinkPaths={selectedBacklinks}
            onNavigate={navigate}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Select a page from the navigation.
          </div>
        )}
      </main>
    </div>
  );
}
