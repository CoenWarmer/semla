import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { WIKI_HOME } from "@/lib/pi/runtime-config";
import {
  buildTitleMap,
  extractWikiLinks,
  WikiConfig,
  WikiLink,
  WikiRegistry,
} from "./wiki-types";

export type {
  WikiConfig,
  WikiLink,
  WikiPageMeta,
  WikiPageType,
  WikiRegistry,
} from "./wiki-types";
export { buildTitleMap, extractWikiLinks } from "./wiki-types";

const WIKI_ROOT = join(WIKI_HOME, ".llm-wiki");
const WIKI_DIR = join(WIKI_ROOT, "wiki");

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

/**
 * Scans every page and returns all directed links as explicit pairs.
 * Handles two link syntaxes that pi-llm-wiki produces:
 *   1. [[entities/some-page]] — path-based wikilinks (primary format)
 *   2. [[Page Title]]         — title-based wikilinks (fallback)
 *   3. [text](/sources/SRC-xxx.md) — markdown links in Links sections
 * Run server-side only.
 */
export function computeWikiLinks(registry: WikiRegistry): WikiLink[] {
  const pages = registry.pages;
  const titleToPath = buildTitleMap(registry);
  const links: WikiLink[] = [];

  for (const path of Object.keys(pages)) {
    const content = getWikiPageContent(path);
    if (!content) continue;
    const seen = new Set<string>();

    const addLink = (target: string) => {
      if (target && target !== path && !seen.has(target)) {
        seen.add(target);
        links.push({ source: path, target });
      }
    };

    // [[...]] wikilinks: try as path first, then as title
    for (const raw of extractWikiLinks(content)) {
      const target = pages[raw] ? raw : titleToPath[raw];
      if (target) addLink(target);
    }

    // Markdown links: [text](/folder/slug.md) — strip leading / and .md suffix
    for (const match of content.matchAll(/\((\/?(?:entities|concepts|sources|syntheses|analyses|requirements)[^)]+\.md)\)/g)) {
      const mdPath = match[1].replace(/^\//, "").replace(/\.md$/, "");
      if (pages[mdPath]) addLink(mdPath);
    }
  }

  return links;
}
