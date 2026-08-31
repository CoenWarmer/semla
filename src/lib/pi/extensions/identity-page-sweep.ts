import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  canonicaliseIdentityPage,
  declaredRepos,
  widenRepos,
} from "./identity-page-canonical.js";
import { PAGE_DIRS } from "./wiki-frontmatter.js";

export interface IdentityFix {
  /** Page that was acted on, as `dir/file.md`. */
  page: string;
  action: "renamed" | "merged" | "retitled";
  /** Where it ended up, for a rename or a merge. */
  into?: string;
}

/**
 * Bring every person and organisation page to its canonical name.
 *
 * Three outcomes, in the order they are preferred:
 *
 *  - **retitled** — the title carried a repo qualifier but already sits at the
 *    right filename, so only the frontmatter and H1 change.
 *  - **renamed** — the canonical filename is free, so the page moves to it and
 *    keeps everything it had.
 *  - **merged** — the canonical page already exists, which is the case this is
 *    really for: two repos each raised the same person. The repos of the
 *    duplicate are folded into the canonical page and the duplicate is moved
 *    out of the wiki tree into `archive/`, not deleted — it is evidence, and
 *    an absorbed page has been worth reading before.
 *
 * `wiki_ensure_page` cannot do any of this itself: on an existing page it
 * returns "already exists" and changes nothing, so a second repo's claim on
 * the same person is dropped on the floor by the tool that was asked to
 * record it.
 */
export function sweepIdentityPages(options: { wikiHome: string }): IdentityFix[] {
  const dotWiki = join(options.wikiHome, ".llm-wiki");
  const wikiDir = join(dotWiki, "wiki");
  const fixes: IdentityFix[] = [];

  for (const dir of PAGE_DIRS) {
    const folder = join(wikiDir, dir);
    let entries: string[];
    try {
      entries = readdirSync(folder);
    } catch {
      continue; // Folder absent until the wiki writes its first page of that type.
    }

    for (const entry of entries) {
      if (!entry.endsWith(".md") || entry === "index.md") continue;
      const path = join(folder, entry);

      let markdown: string;
      try {
        markdown = readFileSync(path, "utf8");
      } catch {
        continue;
      }

      const outcome = canonicaliseIdentityPage(markdown);
      if (!outcome) continue; // Not a person or organisation page.

      const target = join(folder, `${outcome.slug}.md`);

      if (target === path) {
        if (outcome.changed) {
          writeFileSync(path, outcome.content, "utf8");
          fixes.push({ page: `${dir}/${entry}`, action: "retitled" });
        }
        continue;
      }

      if (!existsSync(target)) {
        writeFileSync(path, outcome.content, "utf8");
        renameSync(path, target);
        fixes.push({ page: `${dir}/${entry}`, action: "renamed", into: `${dir}/${outcome.slug}.md` });
        continue;
      }

      foldRepos(target, declaredRepos(markdown));
      archive(dotWiki, dir, entry);
      fixes.push({
        page: `${dir}/${entry}`,
        action: "merged",
        into: `${dir}/${outcome.slug}.md`,
      });
    }
  }

  return fixes;
}

/**
 * Add the duplicate's repos to the canonical page.
 *
 * Uses the same widening rule as synthesis provenance: a page that already
 * claims a repo keeps it, and a repo it has never claimed is appended — the
 * field only ever grows, so a merge cannot take a repo away from a page that
 * earned it.
 */
function foldRepos(target: string, repos: readonly string[]): boolean {
  if (repos.length === 0) return false;
  try {
    const outcome = widenRepos(readFileSync(target, "utf8"), repos);
    if (!outcome.changed) return false;
    writeFileSync(target, outcome.content, "utf8");
    return true;
  } catch {
    return false;
  }
}

/** Move an absorbed page out of the wiki tree, keeping it readable. */
function archive(dotWiki: string, dir: string, entry: string): void {
  try {
    const folder = join(dotWiki, "archive", dir);
    mkdirSync(folder, { recursive: true });
    renameSync(join(dotWiki, "wiki", dir, entry), join(folder, entry));
  } catch {
    // An un-archivable duplicate is better left in place than lost.
  }
}
