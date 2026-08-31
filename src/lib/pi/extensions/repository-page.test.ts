/**
 * Every page declares the repo it belongs to, so the edge existed with no node
 * at the other end. These pin the two things that make the node safe to write
 * mechanically: it lands where wiki_ensure_page would put it, and it never
 * costs an existing page a claim.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { ensureRepositoryPage } from "./repository-page.ts";

let wikiHome: string;
let concepts: string;

beforeEach(() => {
  wikiHome = mkdtempSync(join(tmpdir(), "semla-repopage-"));
  concepts = join(wikiHome, ".llm-wiki", "wiki", "concepts");
  mkdirSync(concepts, { recursive: true });
});

describe("ensureRepositoryPage", () => {
  it("creates the hub page with the declared type", () => {
    const outcome = ensureRepositoryPage({ wikiHome, repo: "semla", owner: "CoenWarmer" });

    expect(outcome.created).toBe(true);
    const page = readFileSync(join(concepts, "semla.md"), "utf8");
    expect(page).toContain("type: repository");
    expect(page).toContain("title: semla");
    expect(page).toContain("repo: semla");
    expect(page).toContain("owner: CoenWarmer");
    expect(page).toContain("[[CoenWarmer]]");
  });

  // The package maps no folder for a free-form type and falls back to
  // concepts, so writing anywhere else would give one repo two pages.
  it("writes where wiki_ensure_page would write it", () => {
    ensureRepositoryPage({ wikiHome, repo: "semla", owner: null });

    expect(existsSync(join(concepts, "semla.md"))).toBe(true);
  });

  it("says so plainly when no remote was captured", () => {
    ensureRepositoryPage({ wikiHome, repo: "semla", owner: null });

    expect(readFileSync(join(concepts, "semla.md"), "utf8")).toContain(
      "No remote was captured",
    );
  });

  it("does not overwrite a page that already exists", () => {
    writeFileSync(join(concepts, "semla.md"), "---\ntype: repository\ntitle: semla\nrepo: semla\n---\n\nHand written.\n", "utf8");

    const outcome = ensureRepositoryPage({ wikiHome, repo: "semla", owner: "CoenWarmer" });

    expect(outcome.created).toBe(false);
    expect(readFileSync(join(concepts, "semla.md"), "utf8")).toContain("Hand written.");
  });

  it("widens an existing page's repos rather than replacing them", () => {
    writeFileSync(join(concepts, "shared.md"), "---\ntype: repository\ntitle: shared\nrepo: other\n---\n\nbody\n", "utf8");

    ensureRepositoryPage({ wikiHome, repo: "shared", owner: null });

    expect(readFileSync(join(concepts, "shared.md"), "utf8")).toContain("repo: [other, shared]");
  });

  it("reads the owner from the repo's own packet when not given one", () => {
    const sources = join(wikiHome, ".llm-wiki", "wiki", "sources");
    const packet = join(wikiHome, ".llm-wiki", "raw", "sources", "SRC-1");
    mkdirSync(sources, { recursive: true });
    mkdirSync(packet, { recursive: true });
    writeFileSync(
      join(sources, "SRC-1.md"),
      "---\ntype: source\ntitle: semla Structure\nsource_id: SRC-1\nrepo: semla\n---\n\nbody\n",
      "utf8",
    );
    writeFileSync(join(packet, "extracted.md"), "git@github.com:CoenWarmer/semla.git\n", "utf8");

    ensureRepositoryPage({ wikiHome, repo: "semla" });

    expect(readFileSync(join(concepts, "semla.md"), "utf8")).toContain("owner: coenwarmer");
  });
});
