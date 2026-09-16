import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { PAGE_DIRS, parseRepoValue, readRepoField } from "./wiki-frontmatter";

/**
 * Give a page the wiki wrote this turn at least one link out of it.
 *
 * Every one of the 50 orphans in this vault is a `type: source` page, and they
 * come from the two tools the system prompt tells the agent to call at the end
 * of a task. Neither produces a link:
 *
 *  - `wiki_observe` (`saveObservation`) writes a body ending at
 *    `*Observed: {timestamp}*` with **no Related section at all** — 47 of the
 *    50.
 *  - `wiki_retro` (`saveInsight`) writes a `## Related` heading followed by the
 *    literal `_Add links to related pages._` and never fills it in — the other
 *    3, and 24 semla pages in total.
 *
 * The tools ask for links: `wiki_retro`'s `body` parameter says "[[wikilinks]]
 * to related wiki pages", `prompts/wiki-retro.md` says "Always add
 * [[wikilinks]]", and this repository's own system prompt spends four lines on
 * the wikilink format. The intent is recorded four times over and it is still
 * not what happens, which is why the links are derived here rather than asked
 * for a fifth time.
 *
 * The cost of not doing it is not cosmetic. A page with nothing linking in and
 * nothing linking out is a topological orphan, and the consolidate skill's
 * Pass A archives orphans older than seven days. In this vault that rule
 * selects 42 pages holding 44% of all the prose the repo's wiki contains —
 * because `commitSynthesis` is the only thing that generates inbound links and
 * it links to entity and concept pages, never to an observation. The pages
 * with the most in them are precisely the ones the graph cannot see.
 *
 * Two sources of links, in descending order of how far they can be trusted:
 *
 *  - **The repository hub**, `concepts/{repo}`, which `ensureRepositoryPage`
 *    guarantees exists. Always correct and always available: the page is about
 *    that repo, which is a fact already in its own frontmatter.
 *  - **Pages the text names**, matched by looking for a page's unqualified
 *    title in the body. Entity titles here are repo-qualified (`semla
 *    OtelSpan`) while prose names the bare symbol, so the qualifier comes off
 *    before matching.
 *
 * Be clear about what the second source is worth. Across this vault's orphans
 * it finds 16 edges over 13 pages — every one of them correct on inspection
 * (`Streamdown`, `PromptInput`, `TanStack Query`, `src/components/ui`), but 13
 * pages out of 50. Not because the matching is weak: there is usually nothing
 * to match, because the repo has 24 entity pages against 713 TypeScript
 * modules. The hub link is what actually keeps a page out of Pass A. Treat it
 * as a floor rather than a graph, and read the 3.4% entity coverage as the real
 * gap — a note cannot link to a page nobody wrote.
 */

/** The literal body `saveInsight` writes under `## Related` and never replaces. */
export const RELATED_PLACEHOLDER = "_Add links to related pages._";

/** A page that could be linked to, as the sweep's index holds it. */
export interface RelatedCandidate {
  /** Page id without the `.md`, e.g. `entities/otel-span`. */
  id: string;
  /** Frontmatter title, still carrying any repo qualifier. */
  title: string;
}

export interface RelatedOutcome {
  changed: boolean;
  content: string;
  /** Page ids linked, in the order they were written. */
  links: string[];
}

/**
 * Shortest unqualified title worth matching on.
 *
 * Length is a crude proxy for how often a title turns up in prose by accident,
 * but on this vault it is enough: at 8 the matches are `Streamdown`,
 * `PromptInput`, `SEMLA_BIND_HOST`, `TanStack Query`, `src/components/ui` and
 * `@earendil-works/pi-coding-agent`, and raising it to 10 changes nothing.
 * Below 8 it starts admitting bare nouns like `Button` and `Dialog`, which
 * appear in any sentence about a UI and would link a page to whatever
 * component happened to have been given an entity page.
 */
const MIN_TITLE_LENGTH = 8;

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

/**
 * Links out of a page, spelled the two ways the vault's extractor counts.
 *
 * Deliberately not code-span-aware, matching the extractor: the system prompt
 * warns the agent not to write `[[...]]` inside inline code for exactly that
 * reason, so a link in a code span is one this sweep must see too or it would
 * add a Related section to a page the graph already considers connected.
 */
const MARKDOWN_LINK =
  /\]\(\/(?:concepts|entities|sources|syntheses|analyses|requirements)\/[^)]+\)/;
const WIKILINK = /\[\[[^\]]+\]\]/;

/** Body with the frontmatter block removed, so a `title:` cannot match itself. */
function bodyOf(markdown: string): string {
  const match = FRONTMATTER.exec(markdown);
  return match ? match[2]! : markdown;
}

/** Title from the frontmatter block only — a `title:` in prose is not one. */
function titleOf(markdown: string): string | null {
  const match = FRONTMATTER.exec(markdown);
  if (!match) return null;
  const declared = /^title:\s*(.+)$/m.exec(match[1]!);
  if (!declared) return null;
  return declared[1]!.trim().replace(/^["']|["']$/g, "") || null;
}

/** `semla OtelSpan` → `OtelSpan`, for a page tagged `semla`. */
function unqualify(title: string, repos: readonly string[]): string {
  for (const repo of repos) {
    if (title.startsWith(`${repo} `)) return title.slice(repo.length + 1).trim();
  }
  return title;
}

/** Whether the page already points at anything in the vault. */
export function hasOutboundLinks(markdown: string): boolean {
  const body = bodyOf(markdown);
  return MARKDOWN_LINK.test(body) || WIKILINK.test(body);
}

/**
 * Give a page links out of it, either by filling `wiki_retro`'s placeholder or
 * by appending the section `wiki_observe` never writes.
 *
 * Idempotent, and safe on a page that was written properly: a page that
 * already links anywhere is returned untouched, so a Related section the agent
 * did fill in is never overwritten with derived links.
 */
export function ensureRelatedLinks(
  markdown: string,
  options: {
    /** Page id of the page being rewritten, so it cannot link to itself. */
    id: string;
    /** Repos the page declares. Each contributes its hub link. */
    repos: readonly string[];
    candidates: readonly RelatedCandidate[];
  },
): RelatedOutcome {
  if (hasOutboundLinks(markdown)) {
    return { changed: false, content: markdown, links: [] };
  }

  const body = bodyOf(markdown);
  const links: string[] = [];

  // The hub first: it is the one link that is always both available and true.
  // A hub page that somehow reached this sweep does not link to itself.
  for (const repo of options.repos) {
    const hub = `concepts/${repo}`;
    if (hub !== options.id) links.push(hub);
  }

  for (const candidate of options.candidates) {
    if (candidate.id === options.id || links.includes(candidate.id)) continue;
    const bare = unqualify(candidate.title, options.repos);
    if (bare.length < MIN_TITLE_LENGTH) continue;
    if (!body.includes(bare)) continue;
    links.push(candidate.id);
  }

  if (links.length === 0) return { changed: false, content: markdown, links: [] };

  // Path-based wikilinks, per the wikilink rules in the system prompt: the link
  // resolver treats a target as a literal page id, so a bare title resolves to
  // nothing and would leave the page an orphan for a second reason.
  const list = links.map((id) => `- [[${id}]]`).join("\n");

  // Filling the placeholder is preferred over appending, so a retro note keeps
  // the one section it has rather than ending up with two.
  const content = markdown.includes(RELATED_PLACEHOLDER)
    ? markdown.replace(RELATED_PLACEHOLDER, list)
    : `${markdown.replace(/\s*$/, "")}\n\n## Related\n\n${list}\n`;

  return { changed: true, content, links };
}

/** One page the sweep connected, and what it now points at. */
export interface RelatedFix {
  id: string;
  links: string[];
}

/** Every page in the vault that could be a link target, indexed by repo. */
function buildCandidateIndex(wikiDir: string): Map<string, RelatedCandidate[]> {
  const byRepo = new Map<string, RelatedCandidate[]>();

  for (const dir of PAGE_DIRS) {
    let entries: string[];
    try {
      entries = readdirSync(join(wikiDir, dir));
    } catch {
      continue; // Folder absent until the wiki writes its first page of that type.
    }

    for (const entry of entries) {
      if (!entry.endsWith(".md") || entry === "index.md") continue;
      try {
        const markdown = readFileSync(join(wikiDir, dir, entry), "utf8");
        const title = titleOf(markdown);
        const declared = readRepoField(markdown);
        if (!title || !declared) continue;
        const parsed = parseRepoValue(declared);
        const candidate = { id: `${dir}/${entry.replace(/\.md$/, "")}`, title };
        for (const repo of Array.isArray(parsed) ? parsed : [parsed]) {
          const list = byRepo.get(repo);
          if (list) list.push(candidate);
          else byRepo.set(repo, [candidate]);
        }
      } catch {
        // An unreadable page is simply not a candidate.
      }
    }
  }

  return byRepo;
}

/**
 * Connect every page written since `since` that has no links out of it.
 *
 * Scoped by modification time for the same reason the repo stamp is: a page
 * left unconnected by an earlier session belongs to that session's repo, and
 * sweeping the whole vault every turn would rewrite pages this turn never
 * touched. The backlog is left to the consolidate skill, which is where a
 * decision about existing pages belongs.
 *
 * Runs after `ensureRepositoryPage`, never before — the hub link is the point
 * of the sweep, and a link to a page that does not exist is a broken link
 * rather than a connection.
 */
export function sweepRelatedLinks(options: {
  wikiHome: string;
  since: number;
  /** Fallback attribution for a page that declares no repo of its own. */
  slugs: readonly string[];
}): RelatedFix[] {
  const wikiDir = join(options.wikiHome, ".llm-wiki", "wiki");
  const fixes: RelatedFix[] = [];
  const candidatesByRepo = buildCandidateIndex(wikiDir);

  for (const dir of PAGE_DIRS) {
    const folder = join(wikiDir, dir);
    let entries: string[];
    try {
      entries = readdirSync(folder);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.endsWith(".md") || entry === "index.md") continue;
      const path = join(folder, entry);
      try {
        if (statSync(path).mtimeMs < options.since) continue;
        const markdown = readFileSync(path, "utf8");
        if (hasOutboundLinks(markdown)) continue;

        const declared = readRepoField(markdown);
        const parsed = declared ? parseRepoValue(declared) : null;
        const repos = parsed ? (Array.isArray(parsed) ? parsed : [parsed]) : options.slugs;
        if (repos.length === 0) continue;

        const id = `${dir}/${entry.replace(/\.md$/, "")}`;
        const candidates = repos.flatMap((repo) => candidatesByRepo.get(repo) ?? []);
        const outcome = ensureRelatedLinks(markdown, { id, repos, candidates });
        if (!outcome.changed) continue;

        writeFileSync(path, outcome.content, "utf8");
        fixes.push({ id, links: outcome.links });
      } catch {
        // A page being rewritten underneath us is picked up on the next turn.
      }
    }
  }

  return fixes;
}
