export type WikiPageType =
  | "entity"
  | "concept"
  | "source"
  | "synthesis"
  | "analysis"
  | "requirement";

export interface WikiPageMeta {
  type: WikiPageType;
  title: string;
  created: string;
  updated?: string;
  status?: string;
  source_id?: string;
  format?: string;
  captured?: string;
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
