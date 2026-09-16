import { readFileSync } from "node:fs";

import type { WikiRecallCandidate } from "../extension-loading/extension-contract";
import { parseRepoValue, readRepoField } from "./wiki-frontmatter";

/**
 * Scope pi-llm-wiki's per-turn auto-recall to the repos a session works in.
 *
 * The package's `before_agent_start` hook searches the whole vault and injects
 * the top 3 hits on every prompt. Measured over 441 real injections in 127
 * sessions, that is worth very little: 91.4% were inert — no page opened, none
 * named in the reply — and 1.3% of the 1,278 pages offered were ever opened.
 * Just under half of what it offered, 578 pages, belonged to a repo the session
 * was not working in at all: 217 from `nightshift-program`, 136 from
 * `catalog-info`, 99 from `kibana`.
 *
 * The package cannot fix this itself. It has `process.cwd()`, which names one
 * directory, while a Semla session can be anchored to several projects — so
 * WIKI_SESSION_REPOS, which the bridge already maintains for source
 * attribution, is the only thing that knows the answer.
 *
 * **What this buys, measured on the same corpus.** Repo scoping alone takes the
 * offered pages from 1,278 to 700 and eliminates all 578 cross-repo hits, at a
 * cost of 3 of the 16 pages the agent ever opened — those 3 were genuinely
 * useful cross-repo hits, and they are the price. Combined with raising the
 * package's `minScore` from 5 to 40 (see the patch) it lands at 523 pages, 12
 * of the 16 opens retained, and roughly 63k of the 142k injected tokens.
 *
 * **What it does not buy.** Precision is still poor — about 2.3% of offered
 * pages opened, up from 1.3%. This halves a cost that was mostly waste; it does
 * not turn auto-recall into a good feature. The reason sits outside this file:
 * the vault has 24 entity pages for a repo with 713 TypeScript modules, so
 * there often is no right page to retrieve.
 *
 * **Fails open on purpose.** A session whose repos are unknown gets everything,
 * and a page that declares no `repo:` is kept rather than dropped. Injecting
 * too much is the status quo and is recoverable; silently injecting nothing
 * would look exactly like the wiki being empty, which is the failure mode
 * PI_AGENT_DIR and the load verification exist to keep out of this codebase.
 */

/** Repos a page declares, read from its own frontmatter. */
function reposOfPage(path: string): string[] | null {
  try {
    const declared = readRepoField(readFileSync(path, "utf8"));
    if (!declared) return null;
    const parsed = parseRepoValue(declared);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // Unreadable page: cannot be shown to be off-repo, so it is kept.
    return null;
  }
}

/**
 * Keep the candidates that belong to one of `sessionRepos`.
 *
 * Pure, and separated from the slot plumbing so the decision is testable
 * without a global, a session or a vault.
 */
export function filterRecallToRepos(
  candidates: readonly WikiRecallCandidate[],
  sessionRepos: readonly string[],
  /** Injected in tests; defaults to reading the page off disk. */
  reposOf: (path: string) => string[] | null = reposOfPage,
): WikiRecallCandidate[] {
  if (sessionRepos.length === 0) return [...candidates];

  return candidates.filter((candidate) => {
    let pageRepos: string[] | null;
    try {
      pageRepos = reposOf(candidate.path);
    } catch {
      // Belt and braces over `reposOfPage`, which already catches. This runs on
      // every prompt, and a reader that throws must not be able to empty the
      // injection — the whole point of the fail-open rule above.
      return true;
    }
    // An untagged page cannot be proven to be about another repo. Concept pages
    // are also deliberately repo-independent and shared, so dropping untagged
    // pages would discard the part of the vault that is meant to cross repos.
    if (!pageRepos || pageRepos.length === 0) return true;
    return pageRepos.some((repo) => sessionRepos.includes(repo));
  });
}
