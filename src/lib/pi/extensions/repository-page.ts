import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ownerForRepo } from "./identity-evidence";
import { widenRepos } from "./identity-page-canonical";

/**
 * The hub page for a repository.
 *
 * Every page already declares the repo it belongs to, so the edge exists — but
 * there was no node at the other end of it. A repository page gives an orient
 * run somewhere to hang what it learned about the repo as a whole: who owns
 * it, who writes it, what it is. Without one, ownership and authorship have
 * nowhere to point, which is part of why no run has produced either.
 *
 * Written here rather than asked of the agent because it is a fact, not a
 * judgement: the repo slug and its remote are both known without a model.
 *
 * Filed in `concepts/` on purpose. The package maps no folder for a
 * free-form type and falls back to concepts, so an agent calling
 * `wiki_ensure_page(type: "repository", ...)` lands exactly here — writing it
 * anywhere else would give the same repo two pages, which is the failure this
 * whole area keeps producing.
 */
export function ensureRepositoryPage(options: {
  wikiHome: string;
  repo: string;
  /** Overrides the owner read from the repo's own packets. */
  owner?: string | null;
}): { created: boolean; path: string } {
  const folder = join(options.wikiHome, ".llm-wiki", "wiki", "concepts");
  const path = join(folder, `${options.repo}.md`);
  const owner = options.owner ?? ownerForRepo(options.wikiHome, options.repo);

  if (existsSync(path)) {
    // The page may predate this repo being oriented, or belong to a repo of
    // the same name elsewhere; either way it gains a claim rather than losing
    // whatever it already had.
    try {
      const outcome = widenRepos(readFileSync(path, "utf8"), [options.repo]);
      if (outcome.changed) writeFileSync(path, outcome.content, "utf8");
    } catch {
      // A page that cannot be widened is still a page.
    }
    return { created: false, path };
  }

  const today = new Date().toISOString().slice(0, 10);
  const ownerLine = owner
    ? `Owned by [[${owner}]] on GitHub.`
    : "No remote was captured, so its owner is not recorded.";

  const body = [
    "---",
    "type: repository",
    `title: ${options.repo}`,
    `repo: ${options.repo}`,
    ...(owner ? [`owner: ${owner}`] : []),
    `created: ${today}`,
    `updated: ${today}`,
    "---",
    "",
    `# ${options.repo}`,
    "",
    "## Summary",
    "",
    `The \`${options.repo}\` repository. ${ownerLine}`,
    "",
    "Pages carrying `repo: " + options.repo + "` belong to it.",
    "",
  ].join("\n");

  try {
    mkdirSync(folder, { recursive: true });
    writeFileSync(path, body, "utf8");
    return { created: true, path };
  } catch {
    return { created: false, path };
  }
}
