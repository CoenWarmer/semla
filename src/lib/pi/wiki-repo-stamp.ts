/**
 * Stamps `repo:` into the frontmatter of wiki pages a session writes.
 *
 * pi-llm-wiki can derive `repo:` on its own, but only inside commitSynthesis
 * and only from the captured source's `file_path`, by walking up to a `.git`
 * directory. Semla's orient flow captures concatenated blobs written to /tmp,
 * which have no `.git` ancestor, so that derivation returns undefined for
 * every source we hand it. Pages the agent writes by hand — the flow the
 * memory-context prompt asks for on small repos — skip that code path
 * entirely. Both roads end at an untagged page, and an untagged page used to
 * be rendered under the vault's own name, so every repo looked like "semla".
 *
 * Semla already knows what the package is trying to infer: the session's
 * project_path. Stamping it server-side takes the tag off the agent's
 * critical path — it cannot be forgotten, and it cannot be written into the
 * wrong block.
 *
 * Only pages that lack the field are touched, so a repo the package or the
 * agent tagged correctly is left exactly as it is.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { WIKI_HOME } from "@/lib/pi/runtime-config";

/** Page folders pi-llm-wiki writes under `<vault>/.llm-wiki/wiki`. */
const PAGE_DIRS = [
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

/** One page the sweep rewrote, and what it now declares. */
export interface StampedPage {
  id: string;
  repo: string;
}

/** The parts of meta/registry.json this module touches. */
interface WikiRegistryFile {
  pages?: Record<string, { repo?: string | string[] }>;
}

/** `[a, b]` → ["a","b"], so the registry carries the shape wiki-types expects. */
function parseRepoValue(value: string): string | string[] {
  if (!value.startsWith("[")) return value;
  return value
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((item) => item.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
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
 * Stamp every page written since `since` that has no repo of its own.
 *
 * Scoped by modification time rather than rewriting the vault: a page created
 * by an earlier orient of a different repo keeps its own tag, and pages this
 * session never touched are left untagged rather than being claimed.
 */
export function stampWikiPages(options: {
  slug: string;
  since: number;
  wikiHome?: string;
}): StampedPage[] {
  const wikiDir = join(options.wikiHome ?? WIKI_HOME, ".llm-wiki", "wiki");
  const stamped: StampedPage[] = [];

  for (const dir of PAGE_DIRS) {
    const full = join(wikiDir, dir);
    let entries: string[];
    try {
      entries = readdirSync(full);
    } catch {
      continue; // Folder absent until the wiki writes its first page of that type.
    }

    for (const entry of entries) {
      if (!entry.endsWith(".md") || entry === "index.md") continue;
      const path = join(full, entry);
      try {
        if (statSync(path).mtimeMs < options.since) continue;
        const outcome = stampRepoFrontmatter(readFileSync(path, "utf8"), options.slug);
        if (!outcome.changed || !outcome.repo) continue;
        writeFileSync(path, outcome.content, "utf8");
        stamped.push({ id: `${dir}/${entry.replace(/\.md$/, "")}`, repo: outcome.repo });
      } catch {
        // A page being rewritten underneath us is picked up on the next turn.
      }
    }
  }

  return stamped;
}

/**
 * Mirror the stamped values into `meta/registry.json`.
 *
 * The graph reads the registry, not the pages, so a stamp that stops at the
 * markdown is invisible. pi-llm-wiki rebuilds this file from frontmatter and
 * carries unrecognised keys through as extension fields, so this patch only
 * has to cover the gap until the next rebuild — after which the field comes
 * back on its own, because it now lives in real frontmatter.
 *
 * Deliberately a direct patch rather than a call into the package's own
 * rebuild: those modules are TypeScript *inside node_modules*, which Node
 * refuses to type-strip and Turbopack cannot resolve from an App Route.
 */
function patchRegistry(wikiHome: string, stamped: StampedPage[]): void {
  const path = join(wikiHome, ".llm-wiki", "meta", "registry.json");

  let registry: WikiRegistryFile;
  try {
    registry = JSON.parse(readFileSync(path, "utf8")) as WikiRegistryFile;
  } catch {
    return; // No registry yet — the wiki's own indexing will pick these pages up.
  }
  if (!registry.pages) return;

  let touched = false;
  for (const page of stamped) {
    const entry = registry.pages[page.id];
    // A page the wiki has not indexed yet is not ours to add: the next rebuild
    // reads the frontmatter we just wrote and indexes it with the repo intact.
    if (!entry) continue;
    entry.repo = parseRepoValue(page.repo);
    touched = true;
  }

  // Matches how pi-llm-wiki serialises the file, so a stamp shows up as a
  // one-field diff rather than reformatting all 575 entries.
  if (touched) writeFileSync(path, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

/**
 * Stamp the pages a turn produced and make the tags visible to the graph.
 */
export async function stampSessionWikiPages(options: {
  projectPath: string | null;
  since: number;
  wikiHome?: string;
}): Promise<StampedPage[]> {
  const slug = repoSlugFromProjectPath(options.projectPath);
  if (!slug) return [];

  // Callers fire this and forget it from a finally block; yield first so the
  // turn finishes tearing down before we start reading the vault.
  await new Promise((resolve) => setImmediate(resolve));

  const wikiHome = options.wikiHome ?? WIKI_HOME;
  const stamped = stampWikiPages({ slug, since: options.since, wikiHome });
  if (stamped.length > 0) patchRegistry(wikiHome, stamped);

  return stamped;
}
