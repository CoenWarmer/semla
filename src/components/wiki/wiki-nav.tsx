"use client";

import { cn } from "@/lib/utils";
import { WikiPageMeta, WikiPageType } from "@/lib/wiki-types";

type NavGroup = WikiPageType | "observation";

const GROUP_ORDER: NavGroup[] = [
  "entity",
  "concept",
  "synthesis",
  "analysis",
  "requirement",
  "source",
  "observation",
];

const GROUP_LABELS: Record<NavGroup, string> = {
  entity: "Entities",
  concept: "Concepts",
  synthesis: "Syntheses",
  analysis: "Analyses",
  requirement: "Requirements",
  source: "Sources",
  observation: "Observations",
};

interface WikiNavProps {
  pages: Record<string, WikiPageMeta>;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}

export function WikiNav({ pages, selectedPath, onSelect }: WikiNavProps) {
  const grouped = groupByNavGroup(pages);

  return (
    <nav className="flex flex-col gap-4 p-3">
      {GROUP_ORDER.filter((group) => grouped[group]?.length).map((group) => (
        <div key={group}>
          <p className="mb-1 px-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {GROUP_LABELS[group]}
          </p>
          <ul className="space-y-0.5">
            {(grouped[group] ?? []).map(([path, meta]) => (
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

function navGroupFor(meta: WikiPageMeta): NavGroup {
  if (meta.type === "source" && meta.status === "observation") {
    return "observation";
  }
  return meta.type;
}

function groupByNavGroup(
  pages: Record<string, WikiPageMeta>,
): Partial<Record<NavGroup, [string, WikiPageMeta][]>> {
  const result: Partial<Record<NavGroup, [string, WikiPageMeta][]>> = {};
  for (const [path, meta] of Object.entries(pages)) {
    const group = navGroupFor(meta);
    if (!result[group]) result[group] = [];
    result[group]!.push([path, meta]);
  }
  return result;
}
