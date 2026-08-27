"use client";

import { useState } from "react";
import { WikiConfig, WikiPageMeta, WikiRegistry } from "@/lib/wiki";
import { WikiNav } from "./wiki-nav";
import { WikiPageView } from "./wiki-page-view";

interface WikiBrowserProps {
  config: WikiConfig | null;
  registry: WikiRegistry | null;
  initialPath: string | null;
}

export function WikiBrowser({
  config,
  registry,
  initialPath,
}: WikiBrowserProps) {
  const [selectedPath, setSelectedPath] = useState<string | null>(
    initialPath,
  );

  const pages = registry?.pages ?? {};
  const selectedMeta: WikiPageMeta | undefined = selectedPath
    ? pages[selectedPath]
    : undefined;

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
            onSelect={setSelectedPath}
          />
        ) : (
          <p className="p-4 text-xs text-muted-foreground">
            No pages indexed yet.
          </p>
        )}
      </aside>

      <main className="flex-1 overflow-y-auto">
        {selectedPath ? (
          <WikiPageView path={selectedPath} meta={selectedMeta} />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Select a page from the navigation.
          </div>
        )}
      </main>
    </div>
  );
}
