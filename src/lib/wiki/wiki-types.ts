export type WikiPageType =
  | "entity"
  | "concept"
  | "source"
  | "synthesis"
  | "analysis"
  | "requirement"
  // The package maps no folder for these, so they are filed under concepts/
  // and identified by this field alone. A closed union that omitted them left
  // their pages in no nav group at all: a person, three organisations and a
  // repository page were written, registered, and invisible in the browser.
  | "person"
  | "organisation"
  | "repository";

export interface WikiPageMeta {
  type: WikiPageType;
  title: string;
  created: string;
  description?: string;
  updated?: string;
  /** One repo slug or a list when the page spans multiple repos. */
  repo?: string | string[];
  status?: string;
  source_id?: string;
  format?: string;
  captured?: string;
}

/** Normalise the polymorphic repo field to a sorted, deduplicated array. */
export function repoList(meta: WikiPageMeta): string[] {
  if (!meta.repo) return [];
  const raw = Array.isArray(meta.repo) ? meta.repo : [meta.repo];
  return [...new Set(raw)].sort();
}

export interface WikiRegistry {
  version: string;
  last_updated: string;
  pages: Record<string, WikiPageMeta>;
}

export interface WikiConfig {
  name: string;
  mode: string;
  topic: string;
  created: string;
  version: string;
  knowledge_format: string;
}

export type NavGroup = WikiPageType | "observation";

export const NAV_GROUP_ORDER: NavGroup[] = [
  // Repository first: it is the hub every other page's `repo:` points at.
  "repository",
  "person",
  "organisation",
  "entity",
  "concept",
  "synthesis",
  "analysis",
  "requirement",
  "source",
  "observation",
];

export function navGroupFor(meta: WikiPageMeta): NavGroup {
  if (meta.type === "source" && meta.status === "observation") {
    return "observation";
  }
  return meta.type;
}

export interface WikiLink {
  source: string;
  target: string;
}

/** Map from page title → path, used to resolve [[Title]] wiki links. */
export function buildTitleMap(
  registry: WikiRegistry,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [path, meta] of Object.entries(registry.pages)) {
    map[meta.title] = path;
  }
  return map;
}

/** Extract all [[Title]] link targets from page markdown. */
export function extractWikiLinks(content: string): string[] {
  const matches = content.matchAll(/\[\[([^\]]+)\]\]/g);
  return [...matches].map((m) => m[1]);
}
