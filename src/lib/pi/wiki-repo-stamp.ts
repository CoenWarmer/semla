/**
 * Stamps `repo:` into wiki pages a session writes, and makes the tag visible.
 *
 * pi-llm-wiki can derive `repo:` itself, but only inside commitSynthesis and
 * only from a captured source's `file_path`. Semla's orient flow captures
 * concatenated text, which has no path at all, so that derivation returns
 * undefined for every source. Pages the agent writes by hand skip the code
 * path entirely. Both roads end at an untagged page, and an untagged page used
 * to render under the vault's own name — so every repo looked like "semla".
 *
 * Attribution comes from a page's source lineage first and the session's
 * project only as a fallback. The clock is deliberately not the deciding
 * factor: with two orients sharing one vault, "written during my turn" claimed
 * 63 of another session's pages.
 *
 * The pure text work lives in extensions/wiki-frontmatter.ts, which the wiki
 * bridge shares.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildSourceRepoIndex,
  lineageRepo,
  PAGE_DIRS,
  parseRepoValue,
  repoSlugFromProjectPath,
  stampRepoFrontmatter,
} from "@/lib/pi/extensions/wiki-frontmatter";
import { WIKI_HOME } from "@/lib/pi/runtime-config";
import { sweepIdentityPages } from "@/lib/pi/extensions/identity-page-sweep";
import { ensureRepositoryPage } from "@/lib/pi/extensions/repository-page";

export {
  buildSourceRepoIndex,
  extractSourceIds,
  lineageRepo,
  repoSlugFromProjectPath,
  stampRepoFrontmatter,
  type StampOutcome,
} from "@/lib/pi/extensions/wiki-frontmatter";

/** One page the sweep rewrote, and what it now declares. */
export interface StampedPage {
  id: string;
  repo: string;
}

/** The parts of meta/registry.json this module touches. */
interface WikiRegistryFile {
  pages?: Record<string, { repo?: string | string[] }>;
}

export function stampWikiPages(options: {
  /** Fallback attribution, used only where a page's lineage says nothing. */
  slugs: readonly string[];
  since: number;
  wikiHome?: string;
}): StampedPage[] {
  const wikiDir = join(options.wikiHome ?? WIKI_HOME, ".llm-wiki", "wiki");
  const stamped: StampedPage[] = [];
  // Built once: every page in the sweep asks the same question of it.
  const sourceRepos = buildSourceRepoIndex(wikiDir);

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
        const markdown = readFileSync(path, "utf8");
        // The session's repo is only the fallback. A page synthesised from
        // another session's source belongs to that source's repo, however
        // recently this turn happened to touch it.
        const fallback = lineageRepo(markdown, sourceRepos) ?? options.slugs;
        const outcome = stampRepoFrontmatter(markdown, fallback);
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
  /**
   * The repos this turn is attributed to — the session's anchor plus anything
   * it wrote to along the way. A page whose lineage names a repo still wins;
   * these are the fallback for pages that have nothing else to go on.
   */
  slugs: readonly string[];
  since: number;
  wikiHome?: string;
}): Promise<StampedPage[]> {
  const slugs = [...new Set(options.slugs.filter(Boolean))];
  if (slugs.length === 0) return [];

  // Callers fire this and forget it from a finally block; yield first so the
  // turn finishes tearing down before we start reading the vault.
  await new Promise((resolve) => setImmediate(resolve));

  const wikiHome = options.wikiHome ?? WIKI_HOME;
  const stamped = stampWikiPages({ slugs, since: options.since, wikiHome });
  if (stamped.length > 0) patchRegistry(wikiHome, stamped);

  // The hub every `repo:` field points at. Created before the sweep so a
  // person or organisation promoted below has a repo page to sit beside.
  // One hub per repo: a page tagged `[a, b]` points at two of them, and a
  // missing hub is a `repo:` field pointing at nothing.
  for (const slug of slugs) {
    const repoPage = ensureRepositoryPage({ wikiHome, repo: slug });
    if (repoPage.created) console.info(`[wiki] created the repository page for ${slug}`);
  }

  // After the stamp, never before: canonicalising a person's page means
  // stripping the repo qualifier from its title, and the only safe way to know
  // which prefix is a qualifier is to read the repo the page itself declares.
  const fixes = sweepIdentityPages({ wikiHome });
  if (fixes.length > 0) {
    console.info(
      `[wiki] canonicalised ${fixes.length} identity page(s): ` +
        fixes.map((fix) => `${fix.page} ${fix.action}${fix.into ? ` → ${fix.into}` : ""}`).join(", "),
    );
  }

  return stamped;
}
