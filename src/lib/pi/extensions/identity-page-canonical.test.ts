/**
 * Pinned against the pages this vault actually grew: one human split into
 * `nightshift-program Coen Warmer`, and one organisation split into
 * `catalog-info Elastic` and `nightshift-program Elastic`.
 */
import { describe, expect, it } from "vitest";

import {
  canonicaliseIdentityPage,
  canonicalTitle,
  declaredRepos,
  readField,
  slugifyTitle,
  widenRepos,
} from "./identity-page-canonical.ts";

const page = (fields: string) => `---\n${fields}\n---\n\n# ${/title: (.*)/.exec(fields)?.[1] ?? ""}\n\nbody\n`;

describe("slugifyTitle", () => {
  it("makes a person's name the canonical firstname-lastname", () => {
    expect(slugifyTitle("Coen Warmer")).toBe("coen-warmer");
  });

  // The package strips the slash, fusing owner and repo into one token:
  // elastic/kibana became `elastickibana` and elastic/catalog-info became
  // `elasticcatalog-info`.
  it("separates an owner from a repo instead of fusing them", () => {
    expect(slugifyTitle("elastic/kibana")).toBe("elastic-kibana");
    expect(slugifyTitle("elastic/catalog-info")).toBe("elastic-catalog-info");
  });

  it("drops punctuation the package also drops", () => {
    expect(slugifyTitle("Elastic, Inc.")).toBe("elastic-inc");
  });
});

describe("declaredRepos", () => {
  it("reads a single repo", () => {
    expect(declaredRepos(page("type: person\ntitle: X\nrepo: semla"))).toEqual(["semla"]);
  });

  it("reads a list", () => {
    expect(declaredRepos(page("type: person\ntitle: X\nrepo: [semla, catalog-info]"))).toEqual([
      "semla",
      "catalog-info",
    ]);
  });

  it("returns nothing when the page claims none", () => {
    expect(declaredRepos(page("type: person\ntitle: X"))).toEqual([]);
  });
});

describe("canonicalTitle", () => {
  it("strips a repo the page itself declares", () => {
    expect(canonicalTitle("nightshift-program Coen Warmer", ["nightshift-program"])).toBe(
      "Coen Warmer",
    );
  });

  it("leaves a name that merely starts with a similar word", () => {
    expect(canonicalTitle("Semlar Jones", ["semla"])).toBe("Semlar Jones");
  });

  it("strips only a repo this page claims, not any repo in the vault", () => {
    expect(canonicalTitle("catalog-info Elastic", ["nightshift-program"])).toBe(
      "catalog-info Elastic",
    );
  });
});

describe("canonicaliseIdentityPage", () => {
  it("ignores a page that is not a person or organisation", () => {
    expect(canonicaliseIdentityPage(page("type: entity\ntitle: semla README.md\nrepo: semla"))).toBeNull();
  });

  it("rewrites both the frontmatter title and the H1", () => {
    const outcome = canonicaliseIdentityPage(
      page("type: person\ntitle: nightshift-program Coen Warmer\nrepo: nightshift-program"),
    );

    expect(outcome?.changed).toBe(true);
    expect(outcome?.title).toBe("Coen Warmer");
    expect(outcome?.slug).toBe("coen-warmer");
    expect(outcome?.content).toContain("title: Coen Warmer");
    expect(outcome?.content).toContain("# Coen Warmer");
    expect(outcome?.content).not.toContain("nightshift-program Coen");
  });

  it("reports an already-canonical page as unchanged but still names its slug", () => {
    const outcome = canonicaliseIdentityPage(page("type: person\ntitle: Coen Warmer\nrepo: semla"));

    expect(outcome?.changed).toBe(false);
    expect(outcome?.slug).toBe("coen-warmer");
  });

  it("handles an organisation the same way", () => {
    const outcome = canonicaliseIdentityPage(
      page("type: organisation\ntitle: catalog-info Elastic\nrepo: catalog-info"),
    );

    expect(outcome?.title).toBe("Elastic");
    expect(outcome?.slug).toBe("elastic");
  });
});

describe("widenRepos", () => {
  it("adds a repo the page has not claimed", () => {
    const outcome = widenRepos(page("type: person\ntitle: Coen Warmer\nrepo: semla"), ["catalog-info"]);

    expect(outcome.changed).toBe(true);
    expect(outcome.content).toContain("repo: [catalog-info, semla]");
  });

  it("never removes a repo the page already earned", () => {
    const outcome = widenRepos(
      page("type: person\ntitle: Coen Warmer\nrepo: [a, b]"),
      ["c"],
    );

    expect(outcome.content).toContain("repo: [a, b, c]");
  });

  it("does nothing when there is nothing to add", () => {
    const start = page("type: person\ntitle: Coen Warmer\nrepo: semla");

    expect(widenRepos(start, ["semla"]).changed).toBe(false);
  });

  it("adds the field to a page that has none", () => {
    const outcome = widenRepos(page("type: person\ntitle: Coen Warmer"), ["semla"]);

    expect(outcome.changed).toBe(true);
    expect(outcome.content).toContain("repo: semla");
  });
});

describe("readField", () => {
  it("reads only the first frontmatter block", () => {
    const doc = "---\ntype: person\n---\n\nbody\n\n---\ntype: entity\n---\n";

    expect(readField(doc, "type")).toBe("person");
  });

  it("returns null when there is no frontmatter", () => {
    expect(readField("# Just a heading\n", "type")).toBeNull();
  });
});
