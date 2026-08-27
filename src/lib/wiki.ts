import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { WIKI_HOME } from "@/lib/pi/runtime-config";

const WIKI_ROOT = join(WIKI_HOME, ".llm-wiki");
const WIKI_DIR = join(WIKI_ROOT, "wiki");

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

export function isWikiInitialized(): boolean {
  return existsSync(join(WIKI_ROOT, "meta", "registry.json"));
}

export function getWikiConfig(): WikiConfig | null {
  const path = join(WIKI_ROOT, "config.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as WikiConfig;
}

export function getWikiRegistry(): WikiRegistry | null {
  const path = join(WIKI_ROOT, "meta", "registry.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as WikiRegistry;
}

/** Returns page markdown with YAML frontmatter stripped. */
export function getWikiPageContent(pagePath: string): string | null {
  const normalized = pagePath.replace(/\.\./g, "").replace(/^\/+/, "");
  const fullPath = join(WIKI_DIR, normalized + ".md");
  if (!existsSync(fullPath)) return null;
  const raw = readFileSync(fullPath, "utf-8");
  return stripFrontmatter(raw);
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return content;
  return content.slice(end + 4).trimStart();
}
