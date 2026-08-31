/**
 * The merge case is the one this exists for. `wiki_ensure_page` returns
 * "already exists" and changes nothing when a second repo raises the same
 * person, so the tool asked to record that claim drops it.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { sweepIdentityPages } from "./identity-page-sweep.ts";

let wikiHome: string;
let entities: string;

const write = (name: string, fields: string) =>
  writeFileSync(
    join(entities, name),
    `---\n${fields}\n---\n\n# ${/title: (.*)/.exec(fields)?.[1] ?? ""}\n\nbody\n`,
    "utf8",
  );

const packet = (id: string, text: string) => {
  const dir = join(wikiHome, ".llm-wiki", "raw", "sources", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "extracted.md"), text, "utf8");
};

beforeEach(() => {
  wikiHome = mkdtempSync(join(tmpdir(), "semla-identity-"));
  entities = join(wikiHome, ".llm-wiki", "wiki", "entities");
  mkdirSync(entities, { recursive: true });
});

describe("sweepIdentityPages", () => {
  it("renames a qualified page when the canonical name is free", () => {
    write("nightshift-program-coen-warmer.md", "type: person\ntitle: nightshift-program Coen Warmer\nrepo: nightshift-program");

    const fixes = sweepIdentityPages({ wikiHome });

    expect(fixes).toEqual([
      { page: "entities/nightshift-program-coen-warmer.md", action: "renamed", into: "entities/coen-warmer.md" },
    ]);
    const moved = readFileSync(join(entities, "coen-warmer.md"), "utf8");
    expect(moved).toContain("title: Coen Warmer");
    expect(moved).toContain("# Coen Warmer");
    expect(existsSync(join(entities, "nightshift-program-coen-warmer.md"))).toBe(false);
  });

  // Both Elastic pages, exactly as this vault grew them.
  it("folds a duplicate into the canonical page and archives it", () => {
    write("elastic.md", "type: organisation\ntitle: Elastic\nrepo: catalog-info");
    write("nightshift-program-elastic.md", "type: organisation\ntitle: nightshift-program Elastic\nrepo: nightshift-program");

    const fixes = sweepIdentityPages({ wikiHome });

    expect(fixes).toContainEqual({
      page: "entities/nightshift-program-elastic.md",
      action: "merged",
      into: "entities/elastic.md",
    });
    expect(readFileSync(join(entities, "elastic.md"), "utf8")).toContain(
      "repo: [catalog-info, nightshift-program]",
    );
    expect(existsSync(join(entities, "nightshift-program-elastic.md"))).toBe(false);
    expect(
      existsSync(join(wikiHome, ".llm-wiki", "archive", "entities", "nightshift-program-elastic.md")),
    ).toBe(true);
  });

  it("retitles in place when the filename is already canonical", () => {
    write("coen-warmer.md", "type: person\ntitle: semla Coen Warmer\nrepo: semla");

    const fixes = sweepIdentityPages({ wikiHome });

    expect(fixes).toEqual([{ page: "entities/coen-warmer.md", action: "retitled" }]);
    expect(readFileSync(join(entities, "coen-warmer.md"), "utf8")).toContain("title: Coen Warmer");
  });

  it("leaves entities and concepts alone", () => {
    write("semla-readme-md.md", "type: entity\ntitle: semla README.md\nrepo: semla");
    write("react-compiler.md", "type: concept\ntitle: React Compiler\nrepo: semla");

    expect(sweepIdentityPages({ wikiHome })).toEqual([]);
    expect(existsSync(join(entities, "semla-readme-md.md"))).toBe(true);
  });

  it("does nothing to a page already canonical", () => {
    write("coen-warmer.md", "type: person\ntitle: Coen Warmer\nrepo: semla");

    expect(sweepIdentityPages({ wikiHome })).toEqual([]);
  });

  // Every person and organisation in the real vault is typed `entity`, so
  // without promotion the sweep would leave all of them exactly as they are.
  it("promotes an entity the commit log says is a person, then canonicalises it", () => {
    packet("SRC-1", "f85eb62 Coen Warmer <coen.warmer@gmail.com> [Wiki]: a commit\n");
    write("nightshift-program-coen-warmer.md", "type: person\ntitle: nightshift-program Coen Warmer\nrepo: nightshift-program".replace("person", "entity"));

    const fixes = sweepIdentityPages({ wikiHome });

    expect(fixes.map((fix) => fix.action)).toEqual(["promoted", "renamed"]);
    const moved = readFileSync(join(entities, "coen-warmer.md"), "utf8");
    expect(moved).toContain("type: person");
    expect(moved).toContain("title: Coen Warmer");
  });

  it("promotes an entity matching the repo owner to an organisation", () => {
    packet("SRC-1", "https://github.com/elastic/kibana\n");
    write("catalog-info-elastic.md", "type: entity\ntitle: catalog-info Elastic\nrepo: catalog-info");

    sweepIdentityPages({ wikiHome });

    const moved = readFileSync(join(entities, "elastic.md"), "utf8");
    expect(moved).toContain("type: organisation");
    expect(moved).toContain("title: Elastic");
  });

  it("leaves an entity the packets say nothing about", () => {
    packet("SRC-1", "f85eb62 Coen Warmer <coen.warmer@gmail.com> [Wiki]: a commit\n");
    write("catalog-info-elastic-agent.md", "type: entity\ntitle: catalog-info Elastic Agent\nrepo: catalog-info");

    expect(sweepIdentityPages({ wikiHome })).toEqual([]);
    expect(existsSync(join(entities, "catalog-info-elastic-agent.md"))).toBe(true);
  });

  it("survives a vault with no pages at all", () => {
    expect(sweepIdentityPages({ wikiHome: mkdtempSync(join(tmpdir(), "semla-empty-")) })).toEqual([]);
  });

  it("is safe to run twice", () => {
    write("nightshift-program-coen-warmer.md", "type: person\ntitle: nightshift-program Coen Warmer\nrepo: nightshift-program");

    sweepIdentityPages({ wikiHome });
    expect(sweepIdentityPages({ wikiHome })).toEqual([]);
  });
});
