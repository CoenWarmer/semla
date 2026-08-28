/**
 * Both halves exist because commitSynthesis silently discards a synthesis whose
 * slug is taken. The fixtures are the real shapes from the vault where that
 * happened: entities/readmemd, which buildkite-tray won and semla lost, and
 * concepts/typescript-project-references, which both repos genuinely have.
 */
import { describe, expect, it } from "vitest";

import {
  mergeProvenance,
  namespacedEntityTitle,
  withNamespacedEntities,
} from "./wiki-page-merge.ts";

describe("namespacedEntityTitle", () => {
  it("qualifies an entity with its repo", () => {
    expect(namespacedEntityTitle("README.md", "semla")).toBe("semla README.md");
  });

  it("is idempotent, so a re-ingest does not stack prefixes", () => {
    const once = namespacedEntityTitle("README.md", "semla");
    expect(namespacedEntityTitle(once, "semla")).toBe(once);
  });

  it("does not re-prefix when the title already leads with the repo", () => {
    expect(namespacedEntityTitle("Semla session-service.ts", "semla")).toBe(
      "Semla session-service.ts",
    );
  });

  it("keeps two repos' same-named files apart", () => {
    expect(namespacedEntityTitle("README.md", "semla")).not.toBe(
      namespacedEntityTitle("README.md", "buildkite-tray"),
    );
  });
});

describe("withNamespacedEntities", () => {
  it("qualifies entities and leaves concepts alone", () => {
    const data = {
      entities: [{ title: "README.md", description: "docs" }],
      concepts: [{ title: "TypeScript project references" }],
    };

    const out = withNamespacedEntities(data, "semla");

    expect(out.entities[0]!.title).toBe("semla README.md");
    expect(out.entities[0]!.description).toBe("docs");
    // Concepts are shared across repos on purpose — namespacing them would
    // fragment one idea into one page per repo.
    expect(out.concepts).toEqual(data.concepts);
  });

  it("leaves a payload with no entities untouched", () => {
    const data = { concepts: [] };
    expect(withNamespacedEntities(data, "semla")).toBe(data);
  });
});

describe("mergeProvenance", () => {
  const page = (front: string) => `---\n${front}\n---\n\n# Title\n\nBody.\n`;
  const existing = [
    "type: concept",
    "title: TypeScript project references",
    "description: A solution-style tsconfig setup.",
    "created: 2026-08-28",
    "updated: 2026-08-28",
    "sources:",
    "  - id: SRC-2026-08-28-008",
    "    resource: /sources/SRC-2026-08-28-008.md",
    "repo: buildkite-tray",
  ].join("\n");

  const merge = (markdown: string, over = {}) =>
    mergeProvenance(markdown, {
      sourceId: "SRC-2026-08-28-015",
      repo: "semla",
      date: "2026-08-29",
      ...over,
    });

  it("appends the new source to the existing list", () => {
    const { changed, content } = merge(page(existing));

    expect(changed).toBe(true);
    expect(content).toContain("  - id: SRC-2026-08-28-008");
    expect(content).toContain("  - id: SRC-2026-08-28-015");
    expect(content).toContain("    resource: /sources/SRC-2026-08-28-015.md");
  });

  it("widens repo into the list form the schema already models", () => {
    expect(merge(page(existing)).content).toContain("repo: [buildkite-tray, semla]");
  });

  it("leaves title, description and body exactly as the first writer left them", () => {
    const { content } = merge(page(existing));

    expect(content).toContain("title: TypeScript project references");
    expect(content).toContain("description: A solution-style tsconfig setup.");
    expect(content).toContain("# Title\n\nBody.");
  });

  it("bumps updated once something actually changed", () => {
    expect(merge(page(existing)).content).toContain("updated: 2026-08-29");
  });

  it("is a no-op when the source and repo are already recorded", () => {
    const merged = merge(page(existing)).content;
    const again = merge(merged);

    expect(again.changed).toBe(false);
    expect(again.content).toBe(merged);
  });

  it("does not duplicate a repo already present in a list", () => {
    const listed = page(existing.replace("repo: buildkite-tray", "repo: [buildkite-tray, semla]"));
    const { content } = merge(listed);

    expect(content.match(/semla/g)?.length).toBe(1);
  });

  it("adds a sources block to a page that has none", () => {
    const bare = page("type: concept\ntitle: Thing\nrepo: semla");
    const { changed, content } = merge(bare, { repo: "semla" });

    expect(changed).toBe(true);
    expect(content).toContain("sources:\n  - id: SRC-2026-08-28-015");
  });

  // Attribution for an untagged page belongs to the lineage sweep, which reads
  // the sources list this merge extends. Writing one repo here would preempt it
  // with a narrower answer that the sweep then refuses to overwrite.
  it("leaves an untagged page untagged, so lineage decides", () => {
    const bare = page("type: concept\ntitle: Thing");
    const { changed, content } = merge(bare);

    expect(changed).toBe(true);
    expect(content).toContain("SRC-2026-08-28-015");
    expect(content).not.toContain("repo:");
  });

  it("records the source even when the session repo is unknown", () => {
    const { changed, content } = merge(page(existing), { repo: null });

    expect(changed).toBe(true);
    expect(content).toContain("SRC-2026-08-28-015");
    expect(content).toContain("repo: buildkite-tray");
  });

  it.each([
    ["a page with no frontmatter", "# Just a heading\n"],
    ["an unterminated frontmatter block", "---\ntype: concept\n"],
  ])("leaves %s untouched", (_label, input) => {
    expect(mergeProvenance(input, {
      sourceId: "SRC-1",
      repo: "semla",
      date: "2026-08-29",
    })).toEqual({ changed: false, content: input });
  });
});
