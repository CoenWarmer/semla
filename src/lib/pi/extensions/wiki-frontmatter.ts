/**
 * Pure frontmatter work for wiki pages: what `repo:` should say, and where it
 * goes.
 *
 * Split out of wiki-repo-stamp.ts because the wiki bridge needs the same logic
 * and is loaded by jiti, which does not resolve the `@/` alias that module uses
 * for WIKI_HOME. Nothing here touches configuration — it is text in, text out —
 * so both sides can share it without either dragging in the other's imports.
 */

import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

/** Page folders pi-llm-wiki writes under `<vault>/.llm-wiki/wiki`. */
export const PAGE_DIRS = [
  "entities",
  "concepts",
  "sources",
  "syntheses",
  "analyses",
  "requirements",
] as const;


/**
 * Repo slug for a session's project path.
 *
 * Deliberately `basename` with no case folding: it is exactly what
 * pi-llm-wiki's own `repoFromFilePath` produces, so a page the package tags
 * and a page Semla tags land on the same slug instead of splitting into two
 * legend entries.
 */
export function repoSlugFromProjectPath(
  projectPath: string | null | undefined,
): string | null {
  if (!projectPath) return null;
  const trimmed = projectPath.replace(/[/\\]+$/, "");
  if (!trimmed) return null;
  const slug = basename(trimmed);
  return slug && slug !== "." && slug !== ".." ? slug : null;
}

/**
 * Reduce a `repo:` value the agent wrote to the slug form the graph groups by.
 * The memory-context prompt used to interpolate the session's absolute path,
 * so pages in the wild carry `/Users/me/Dev/thing` where `thing` was meant.
 * YAML lists are left alone — a multi-repo page is already deliberate.
 */
function normalizeRepoValue(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (value.startsWith("[")) return value;
  const unquoted = value.replace(/^["']|["']$/g, "");
  if (!unquoted) return null;
  return unquoted.includes("/") ? basename(unquoted.replace(/\/+$/, "")) : unquoted;
}

const isFence = (line: string) => line.trim() === "---";
const repoKey = /^repo\s*:/;

/**
 * Keys pi-llm-wiki recognises in frontmatter — its STANDARD_FIELDS plus the
 * extension keys the vault already carries. A trailing block built only from
 * these is duplicated metadata the parser never reads, so dropping it loses
 * nothing; a block with anything else in it is page content and stays put.
 */
const FRONTMATTER_KEYS = new Set([
  "type", "title", "description", "resource", "tags", "sources", "generated",
  "verified", "status", "stale_after", "category", "domain", "aliases",
  "recall_triggers", "created", "updated", "summary", "raw_path", "source_id",
  "repo", "format", "captured", "slug", "relevance", "observed_at",
  "source_context",
]);

const isFrontmatterKeyLine = (line: string): boolean => {
  const key = /^([A-Za-z_][\w-]*)\s*:/.exec(line.trim());
  return key !== null && FRONTMATTER_KEYS.has(key[1]!);
};

/** Index of the fence closing the frontmatter block that opens at `open`. */
function findFence(lines: string[], open: number): number {
  for (let i = open + 1; i < lines.length; i += 1) {
    if (isFence(lines[i]!)) return i;
  }
  return -1;
}

export interface StampOutcome {
  changed: boolean;
  content: string;
  /** What the page declares once this call is done, or null if nothing changed. */
  repo: string | null;
}

/**
 * Ensure the page's real frontmatter carries a `repo:` field.
 *
 * Also absorbs the malformed shape the agent produces when told to add the
 * field to a page it has already written: a *second* `---` block holding only
 * `repo:`, sitting after the frontmatter has closed. Every page in the vault
 * that carried the field had it in that orphan block, where the parser reads
 * it as body prose and the registry never sees it.
 */
export function stampRepoFrontmatter(markdown: string, slug: string): StampOutcome {
  const unchanged: StampOutcome = { changed: false, content: markdown, repo: null };

  const lines = markdown.split("\n");
  if (lines.length === 0 || !isFence(lines[0]!)) return unchanged;

  const close = findFence(lines, 0);
  if (close === -1) return unchanged;

  // An orphan block may follow, separated by blank lines.
  let cursor = close + 1;
  while (cursor < lines.length && lines[cursor]!.trim() === "") cursor += 1;

  let orphanRepo: string | null = null;
  let orphanEnd = -1;
  if (cursor < lines.length && isFence(lines[cursor]!)) {
    const orphanClose = findFence(lines, cursor);
    if (orphanClose !== -1) {
      const meaningful = lines
        .slice(cursor + 1, orphanClose)
        .filter((line) => line.trim() !== "");
      const declared = meaningful.find((line) => repoKey.test(line.trim()));

      if (declared) {
        // The page named a repo, just in the block nobody parses. Its own claim
        // beats the session's — stamping the session slug over a page about
        // another repo is the mislabelling this whole module exists to stop.
        orphanRepo = normalizeRepoValue(declared.trim().replace(repoKey, ""));
        if (meaningful.every(isFrontmatterKeyLine)) orphanEnd = orphanClose;
      }
    }
  }

  const front = lines.slice(1, close);
  const existing = front.findIndex((line) => repoKey.test(line));

  const value = orphanRepo ?? slug;
  const next = [...lines];

  // Drop the orphan (and the gap ahead of it) first, so the insert below still
  // lands on the closing fence's original index.
  if (orphanEnd !== -1) next.splice(close + 1, orphanEnd - close);

  if (existing === -1) {
    next.splice(close, 0, `repo: ${value}`);
  }

  const content = next.join("\n");
  if (content === markdown) return { changed: false, content: markdown, repo: null };

  // An already-tagged page whose orphan block was removed keeps its own value.
  const declared =
    existing === -1 ? value : normalizeRepoValue(front[existing]!.replace(repoKey, ""));

  return { changed: true, content, repo: declared };
}

/**
 * Source ids a page was synthesised from, read from its frontmatter only.
 *
 * The body cites the same ids in prose and link targets, so scanning the whole
 * file would attribute a page to any repo it merely mentions.
 */
export function extractSourceIds(markdown: string): string[] {
  const lines = markdown.split("\n");
  if (!isFence(lines[0] ?? "")) return [];
  const close = findFence(lines, 0);
  if (close === -1) return [];

  const ids = lines
    .slice(1, close)
    .flatMap((line) => [...line.matchAll(/\b(SRC-[A-Za-z0-9-]+)/g)].map((m) => m[1]!));
  return [...new Set(ids)];
}

/**
 * Repo of every source page in the vault, so derived pages can inherit it.
 *
 * This is what makes attribution independent of the clock. A page belongs to
 * the repo of the source it was built from — a fact that does not change no
 * matter which session's turn happens to end first, or how many orients are
 * running at once.
 */
/** The `repo:` a page declares, read from its frontmatter block only. */
export function readRepoField(markdown: string): string | null {
  const lines = markdown.split("\n");
  if (!isFence(lines[0] ?? "")) return null;
  const close = findFence(lines, 0);
  if (close === -1) return null;
  const declared = lines.slice(1, close).find((line) => repoKey.test(line));
  return declared ? normalizeRepoValue(declared.replace(repoKey, "")) : null;
}

export function buildSourceRepoIndex(wikiDir: string): Map<string, string> {
  const index = new Map<string, string>();
  let entries: string[];
  try {
    entries = readdirSync(join(wikiDir, "sources"));
  } catch {
    return index;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".md") || entry === "index.md") continue;
    try {
      const lines = readFileSync(join(wikiDir, "sources", entry), "utf8").split("\n");
      if (!isFence(lines[0] ?? "")) continue;
      const close = findFence(lines, 0);
      if (close === -1) continue;
      const declared = lines.slice(1, close).find((line) => repoKey.test(line));
      if (!declared) continue;
      const repo = normalizeRepoValue(declared.replace(repoKey, ""));
      if (repo) index.set(entry.replace(/\.md$/, ""), repo);
    } catch {
      // Unreadable source page: the page it fed falls back to the session repo.
    }
  }
  return index;
}

/**
 * Repo a page inherits from the sources it was synthesised from, or null when
 * it has no usable lineage. Distinct repos become a YAML list, which is what
 * WikiPageMeta.repo already models for pages that genuinely span repos.
 */
export function lineageRepo(
  markdown: string,
  sourceRepos: Map<string, string>,
): string | null {
  const repos = new Set(
    extractSourceIds(markdown)
      .map((id) => sourceRepos.get(id))
      .filter((repo): repo is string => Boolean(repo)),
  );
  if (repos.size === 0) return null;
  const sorted = [...repos].sort();
  return sorted.length === 1 ? sorted[0]! : `[${sorted.join(", ")}]`;
}

/** `[a, b]` → ["a","b"], so the registry carries the shape wiki-types expects. */

/** `[a, b]` → ["a","b"], so the registry carries the shape wiki-types expects. */
export function parseRepoValue(value: string): string | string[] {
  if (!value.startsWith("[")) return value;
  return value
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((item) => item.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

/**
 * Stamp every page written since `since` that has no repo of its own.
 *
 * Scoped by modification time rather than rewriting the vault: a page created
 * by an earlier orient of a different repo keeps its own tag, and pages this
 * session never touched are left untagged rather than being claimed.
 */
