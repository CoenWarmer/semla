import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { canonicalTitle, declaredRepos, readField } from "./identity-page-canonical.js";

/**
 * Decide whether a page names a person or an organisation by looking it up,
 * not by guessing its shape.
 *
 * The sweep next door only acts on pages that already declare `type: person`
 * or `type: organisation`, which means it only helps once the agent has
 * already classified correctly — the easier half. Every person and
 * organisation currently in this vault is typed `entity`, so none of them
 * would be touched.
 *
 * A shape heuristic is the obvious bridge and the wrong one: "two capitalised
 * words" scores `Coen Warmer`, `Elastic Agent` and `React Compiler` alike, and
 * the action taken is a rename or a merge, not a note.
 *
 * The packets now carry the answer. The History facet captures `%an <%ae>` for
 * every commit, and the Structure facet captures the remote — so the set of
 * people who wrote this code and the handle that owns it are both facts on
 * disk. A title that matches one of those is not a guess about a name's shape.
 */
export interface IdentityEvidence {
  /** Commit author names, lowercased. */
  authors: Set<string>;
  /** Repository owner handles from remotes, lowercased. */
  owners: Set<string>;
}

export const EMPTY_EVIDENCE: IdentityEvidence = {
  authors: new Set(),
  owners: new Set(),
};

/**
 * Commit author names in a History packet.
 *
 * Anchored on the leading hash so it reads the `%an` position and nothing
 * else. Bodies are in the same packet and carry `Co-Authored-By:` trailers
 * with the same `Name <email>` shape; those do not begin with a hash, so they
 * are not mistaken for the commit's own author.
 */
export function extractAuthors(text: string): string[] {
  const found = new Set<string>();
  for (const line of text.split("\n")) {
    const match = /^[0-9a-f]{7,40}\s+(.+?)\s+<[^>]+>\s/.exec(line);
    const name = match?.[1]?.trim();
    // A bot is not a person, and its name is the one thing here that reliably
    // says so.
    if (name && !/\[bot\]$/i.test(name)) found.add(name.toLowerCase());
  }
  return [...found];
}

/** Owner handles from any GitHub remote URL in a packet. */
export function extractOwners(text: string): string[] {
  const found = new Set<string>();
  const pattern = /github\.com[:/]([A-Za-z0-9][A-Za-z0-9._-]*)\/[A-Za-z0-9._-]+/g;
  for (const match of text.matchAll(pattern)) {
    const owner = match[1];
    if (owner) found.add(owner.toLowerCase());
  }
  return [...found];
}

/** Read every captured packet and collect the names it establishes. */
export function collectIdentityEvidence(wikiHome: string): IdentityEvidence {
  const rawSources = join(wikiHome, ".llm-wiki", "raw", "sources");
  const authors = new Set<string>();
  const owners = new Set<string>();

  let ids: string[];
  try {
    ids = readdirSync(rawSources);
  } catch {
    return EMPTY_EVIDENCE;
  }

  for (const id of ids) {
    let text: string;
    try {
      text = readFileSync(join(rawSources, id, "extracted.md"), "utf8");
    } catch {
      continue;
    }
    for (const author of extractAuthors(text)) authors.add(author);
    for (const owner of extractOwners(text)) owners.add(owner);
  }

  return { authors, owners };
}

/**
 * The type a page should carry, or null to leave it alone.
 *
 * Only ever promotes an `entity`: a page that already declares its own type is
 * the agent's judgement and is not second-guessed, and concepts are left out
 * because the damage is in entities and a concept named after a person is
 * rarer than a concept that would be wrecked by moving it.
 *
 * A handle that is both an owner and a commit author is a personal account,
 * so it is a person — `CoenWarmer` owning three repos is the same human as the
 * `Coen Warmer` who wrote the commits, and calling it an organisation is what
 * split them in the first place.
 */
export function typeFromEvidence(
  markdown: string,
  evidence: IdentityEvidence,
): "person" | "organisation" | null {
  if (readField(markdown, "type") !== "entity") return null;

  const title = readField(markdown, "title");
  if (!title) return null;

  const bare = canonicalTitle(title, declaredRepos(markdown)).toLowerCase();
  if (!bare) return null;

  if (evidence.authors.has(bare)) return "person";

  // A GitHub handle has no spaces, so it can never equal an author name
  // literally. Squashing both sides is what lets the owner `CoenWarmer` meet
  // the author `Coen Warmer` and be recognised as one human rather than an
  // organisation — which is exactly how they came to be two pages.
  const squashed = bare.replace(/\s+/g, "");
  const authorsSquashed = new Set(
    [...evidence.authors].map((author) => author.replace(/\s+/g, "")),
  );
  if (authorsSquashed.has(squashed)) return "person";

  if (evidence.owners.has(bare)) return "organisation";
  return null;
}

/** Rewrite a page's `type:` field. */
export function retypePage(markdown: string, type: string): string {
  return markdown.replace(/^type:\s*entity\s*$/m, `type: ${type}`);
}

/**
 * The owner handle for one repo, from that repo's own packets.
 *
 * Deliberately not the global owner set: with three repos in a shared vault,
 * asking "who owns something around here" would answer for the wrong one. A
 * source page declares the repo it was captured for, and its packet is where
 * the remote is, so the two together scope the answer.
 */
export function ownerForRepo(wikiHome: string, repo: string): string | null {
  const dotWiki = join(wikiHome, ".llm-wiki");
  const sourcesDir = join(dotWiki, "wiki", "sources");

  let pages: string[];
  try {
    pages = readdirSync(sourcesDir);
  } catch {
    return null;
  }

  for (const page of pages) {
    if (!page.endsWith(".md") || page === "index.md") continue;
    let markdown: string;
    try {
      markdown = readFileSync(join(sourcesDir, page), "utf8");
    } catch {
      continue;
    }
    if (!declaredRepos(markdown).includes(repo)) continue;

    const id = readField(markdown, "source_id") ?? page.replace(/\.md$/, "");
    let packet: string;
    try {
      packet = readFileSync(join(dotWiki, "raw", "sources", id, "extracted.md"), "utf8");
    } catch {
      continue;
    }
    const owners = extractOwners(packet);
    if (owners[0]) return owners[0];
  }

  return null;
}
