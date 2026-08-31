/**
 * A lookup against captured facts, not a guess about a title's shape. The
 * fixtures are the real formats: `%h %an <%ae> %s` from the History facet and
 * a remote URL from the Structure facet.
 */
import { describe, expect, it } from "vitest";

import {
  collectIdentityEvidence,
  extractAuthors,
  extractOwners,
  retypePage,
  typeFromEvidence,
  type IdentityEvidence,
} from "./identity-evidence.ts";

const HISTORY = `f85eb62 Coen Warmer <coen.warmer@gmail.com> [WikiIngest]: Accept a snapshot
Wiring bridge-dispatched runs to the debug writer did not make them appear.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
---
26668ba Roshan Kumar <roshan@elastic.co> [Prompts]: Give a person one page
---
1234567 dependabot[bot] <bot@github.com> chore: bump a dependency
---
`;

const evidence = (authors: string[], owners: string[]): IdentityEvidence => ({
  authors: new Set(authors),
  owners: new Set(owners),
});

const page = (fields: string) => `---\n${fields}\n---\n\n# x\n\nbody\n`;

describe("extractAuthors", () => {
  it("reads the author of each commit", () => {
    expect(extractAuthors(HISTORY)).toContain("coen warmer");
    expect(extractAuthors(HISTORY)).toContain("roshan kumar");
  });

  // The trailer has the same `Name <email>` shape and sits in the same packet;
  // anchoring on the leading hash is what keeps it out.
  it("does not mistake a Co-Authored-By trailer for the author", () => {
    expect(extractAuthors(HISTORY)).not.toContain("claude opus 5 (1m context)");
  });

  it("leaves bots out, since a bot is not a person", () => {
    expect(extractAuthors(HISTORY).some((name) => name.includes("dependabot"))).toBe(false);
  });

  it("finds nothing in a packet with no log in it", () => {
    expect(extractAuthors("# semla Overview\n\nJust prose.\n")).toEqual([]);
  });
});

describe("extractOwners", () => {
  it("reads an ssh remote", () => {
    expect(extractOwners("git@github.com:CoenWarmer/semla.git")).toEqual(["coenwarmer"]);
  });

  it("reads an https remote", () => {
    expect(extractOwners("https://github.com/elastic/kibana")).toEqual(["elastic"]);
  });

  it("finds nothing when there is no remote", () => {
    expect(extractOwners("Pipfile\nrenovate.json\n")).toEqual([]);
  });
});

describe("typeFromEvidence", () => {
  it("promotes an entity whose name wrote the commits", () => {
    const markdown = page("type: entity\ntitle: nightshift-program Coen Warmer\nrepo: nightshift-program");

    expect(typeFromEvidence(markdown, evidence(["coen warmer"], []))).toBe("person");
  });

  it("promotes an entity that matches the repo owner", () => {
    const markdown = page("type: entity\ntitle: catalog-info Elastic\nrepo: catalog-info");

    expect(typeFromEvidence(markdown, evidence([], ["elastic"]))).toBe("organisation");
  });

  // The case that split one human in two: the handle owns the repos and the
  // spaced name wrote the commits.
  it("calls a personal-account owner a person, not an organisation", () => {
    const markdown = page("type: entity\ntitle: CoenWarmer\nrepo: semla");

    expect(typeFromEvidence(markdown, evidence(["coen warmer"], ["coenwarmer"]))).toBe("person");
  });

  it("leaves an entity that matches nothing", () => {
    const markdown = page("type: entity\ntitle: catalog-info Elastic Agent\nrepo: catalog-info");

    expect(typeFromEvidence(markdown, evidence(["coen warmer"], ["elastic"]))).toBeNull();
  });

  it("leaves a concept alone even when the name matches", () => {
    const markdown = page("type: concept\ntitle: Coen Warmer\nrepo: semla");

    expect(typeFromEvidence(markdown, evidence(["coen warmer"], []))).toBeNull();
  });

  it("does not second-guess a type the agent already declared", () => {
    const markdown = page("type: person\ntitle: Coen Warmer\nrepo: semla");

    expect(typeFromEvidence(markdown, evidence(["coen warmer"], []))).toBeNull();
  });

  it("promotes nothing when no packet established anything", () => {
    const markdown = page("type: entity\ntitle: semla Coen Warmer\nrepo: semla");

    expect(typeFromEvidence(markdown, evidence([], []))).toBeNull();
  });
});

describe("retypePage", () => {
  it("rewrites the type and leaves the rest", () => {
    const out = retypePage(page("type: entity\ntitle: Coen Warmer\nrepo: semla"), "person");

    expect(out).toContain("type: person");
    expect(out).toContain("title: Coen Warmer");
    expect(out).toContain("repo: semla");
  });
});

describe("collectIdentityEvidence", () => {
  it("returns nothing for a vault with no packets", () => {
    const empty = collectIdentityEvidence("/nonexistent-vault");

    expect(empty.authors.size).toBe(0);
    expect(empty.owners.size).toBe(0);
  });
});
