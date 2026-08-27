"use client";

import { cn } from "@/lib/utils";
import { WikiPageMeta, WikiPageType } from "@/lib/wiki";

const TYPE_ORDER: WikiPageType[] = [
  "entity",
  "concept",
  "synthesis",
  "analysis",
  "requirement",
  "source",
];

const TYPE_LABELS: Record<WikiPageType, string> = {
  entity: "Entities",
  concept: "Concepts",
  synthesis: "Syntheses",
  analysis: "Analyses",
  requirement: "Requirements",
  source: "Sources",
};

interface WikiNavProps {
  pages: Record<string, WikiPageMeta>;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}

export function WikiNav({ pages, selectedPath, onSelect }: WikiNavProps) {
  const grouped = groupByType(pages);

  return (
    <nav className="flex flex-col gap-4 p-3">
      {TYPE_ORDER.filter((type) => grouped[type]?.length).map((type) => (
        <div key={type}>
          <p className="mb-1 px-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {TYPE_LABELS[type]}
          </p>
          <ul className="space-y-0.5">
            {(grouped[type] ?? []).map(([path, meta]) => (
              <li key={path}>
                <button
                  onClick={() => onSelect(path)}
                  className={cn(
                    "w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                    selectedPath === path
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                  )}
                >
                  {meta.title}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function groupByType(
  pages: Record<string, WikiPageMeta>,
): Partial<Record<WikiPageType, [string, WikiPageMeta][]>> {
  const result: Partial<Record<WikiPageType, [string, WikiPageMeta][]>> = {};
  for (const [path, meta] of Object.entries(pages)) {
    if (!result[meta.type]) result[meta.type] = [];
    result[meta.type]!.push([path, meta]);
  }
  return result;
}
