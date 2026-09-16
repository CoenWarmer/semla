/**
 * Two page shapes matter here, because the two tools the system prompt tells
 * the agent to call at the end of a task leave different holes:
 * `wiki_observe` writes no Related section at all, and `wiki_retro` writes one
 * containing a placeholder it never replaces. Both literals are pinned against
 * the installed package in `wiki-package-contract.test.ts`; what is pinned
 * here is the derivation, and above all that a page which already links
 * somewhere is left alone — overwriting a Related section the agent did fill
 * in would destroy the only good links in the vault.
 */
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ensureRelatedLinks,
  hasOutboundLinks,
  RELATED_PLACEHOLDER,
  sweepRelatedLinks,
} from "./related-links-sweep.ts";

/** What `saveObservation` produces: prose, a timestamp, no Related section. */
const observation = (body: string, front = "type: source\ntitle: A note\nrepo: semla") =>
  `---\n${front}\n---\n\n# A note\n\n${body}\n\n---\n*Observed: 2026-09-09T12:52:21.290Z*`;

/** What `saveInsight` produces: a Related section holding only the placeholder. */
const retro = (body: string, front = "type: source\ntitle: A note\nrepo: semla") =>
  `---\n${front}\n---\n\n# A note\n\n${body}\n\n## Related\n\n${RELATED_PLACEHOLDER}`;

const linked = (target: string) =>
  ensureRelatedLinks(observation(`Prose. ${target}`), {
    id: "sources/a-note",
    repos: ["semla"],
    candidates: [],
  });

describe("hasOutboundLinks", () => {
  it("counts a path-based wikilink", () => {
    expect(hasOutboundLinks(observation("See [[entities/otel-span]]."))).toBe(true);
  });

  it("counts a vault-relative markdown link", () => {
    expect(hasOutboundLinks(observation("See [it](/entities/otel-span.md)."))).toBe(true);
  });

  it("does not count an external link", () => {
    expect(hasOutboundLinks(observation("See [docs](https://example.com/a.md)."))).toBe(false);
  });

  it("does not count the page's own frontmatter", () => {
    expect(hasOutboundLinks(observation("Plain prose."))).toBe(false);
  });
});

describe("ensureRelatedLinks", () => {
  it("appends a Related section to an observation, which has none", () => {
    const outcome = ensureRelatedLinks(observation("Some prose."), {
      id: "sources/a-note",
      repos: ["semla"],
      candidates: [],
    });

    expect(outcome.changed).toBe(true);
    expect(outcome.links).toEqual(["concepts/semla"]);
    expect(outcome.content).toContain("## Related\n\n- [[concepts/semla]]");
    // The observation's own trailer survives; the section goes after it.
    expect(outcome.content).toContain("*Observed: 2026-09-09T12:52:21.290Z*");
  });

  it("fills a retro note's placeholder instead of adding a second section", () => {
    const outcome = ensureRelatedLinks(retro("Some prose."), {
      id: "sources/a-note",
      repos: ["semla"],
      candidates: [],
    });

    expect(outcome.changed).toBe(true);
    expect(outcome.content).toContain("- [[concepts/semla]]");
    expect(outcome.content).not.toContain(RELATED_PLACEHOLDER);
    expect(outcome.content.match(/## Related/g)).toHaveLength(1);
  });

  it("links a page whose unqualified title the text names", () => {
    const outcome = ensureRelatedLinks(observation("The bug was in OtelSpan rounding."), {
      id: "sources/a-note",
      repos: ["semla"],
      candidates: [{ id: "entities/otel-span", title: "semla OtelSpan" }],
    });

    expect(outcome.links).toEqual(["concepts/semla", "entities/otel-span"]);
  });

  it("leaves a title the text does not mention alone", () => {
    const outcome = ensureRelatedLinks(observation("Nothing to do with spans."), {
      id: "sources/a-note",
      repos: ["semla"],
      candidates: [{ id: "entities/otel-span", title: "semla OtelSpan" }],
    });

    expect(outcome.links).toEqual(["concepts/semla"]);
  });

  it("ignores a title too short to be distinctive in prose", () => {
    const outcome = ensureRelatedLinks(observation("We added a Button to the panel."), {
      id: "sources/a-note",
      repos: ["semla"],
      candidates: [{ id: "entities/button", title: "semla Button" }],
    });

    expect(outcome.links).toEqual(["concepts/semla"]);
  });

  it.each([
    ["a wikilink", "See [[entities/otel-span]]."],
    ["a markdown link", "See [it](/entities/otel-span.md)."],
  ])("does not touch a page that already links out via %s", (_label, target) => {
    const outcome = linked(target);

    expect(outcome.changed).toBe(false);
    expect(outcome.links).toEqual([]);
  });

  it("is idempotent — the link it added is itself an outbound link", () => {
    const first = ensureRelatedLinks(observation("Prose."), {
      id: "sources/a-note",
      repos: ["semla"],
      candidates: [],
    });
    const second = ensureRelatedLinks(first.content, {
      id: "sources/a-note",
      repos: ["semla"],
      candidates: [],
    });

    expect(second.changed).toBe(false);
    expect(second.content).toBe(first.content);
  });

  it("never links a page to itself", () => {
    const outcome = ensureRelatedLinks(observation("About semla itself."), {
      id: "concepts/semla",
      repos: ["semla"],
      candidates: [{ id: "concepts/semla", title: "semla" }],
    });

    expect(outcome.changed).toBe(false);
    expect(outcome.links).toEqual([]);
  });

  it("links one hub per repo for a page that spans several", () => {
    const outcome = ensureRelatedLinks(
      observation("Prose.", "type: source\ntitle: A note\nrepo: [semla, kibana]"),
      { id: "sources/a-note", repos: ["semla", "kibana"], candidates: [] },
    );

    expect(outcome.links).toEqual(["concepts/semla", "concepts/kibana"]);
  });

  it("strips the qualifier of any declared repo before matching a title", () => {
    const outcome = ensureRelatedLinks(
      observation("Touches OtelSpan.", "type: source\ntitle: A note\nrepo: [semla, kibana]"),
      {
        id: "sources/a-note",
        repos: ["semla", "kibana"],
        candidates: [{ id: "entities/otel-span", title: "kibana OtelSpan" }],
      },
    );

    expect(outcome.links).toContain("entities/otel-span");
  });
});

describe("sweepRelatedLinks", () => {
  const vault = () => {
    const home = mkdtempSync(join(tmpdir(), "related-sweep-"));
    const wiki = join(home, ".llm-wiki", "wiki");
    for (const dir of ["sources", "concepts", "entities"]) {
      mkdirSync(join(wiki, dir), { recursive: true });
    }
    return { home, wiki };
  };

  const write = (path: string, content: string, mtime?: number) => {
    writeFileSync(path, content, "utf8");
    if (mtime !== undefined) utimesSync(path, mtime / 1000, mtime / 1000);
  };

  const seedHubAndEntity = (wiki: string) => {
    write(
      join(wiki, "concepts", "semla.md"),
      "---\ntype: repository\ntitle: semla\nrepo: semla\n---\n",
    );
    write(
      join(wiki, "entities", "otel-span.md"),
      "---\ntype: entity\ntitle: semla OtelSpan\nrepo: semla\n---\n",
    );
  };

  it("connects an observation written this turn and reports what it linked", () => {
    const { home, wiki } = vault();
    seedHubAndEntity(wiki);
    write(join(wiki, "sources", "a-note.md"), observation("Fixed OtelSpan rounding."));

    const fixes = sweepRelatedLinks({ wikiHome: home, since: 0, slugs: ["semla"] });

    expect(fixes).toContainEqual({
      id: "sources/a-note",
      links: ["concepts/semla", "entities/otel-span"],
    });
    const written = readFileSync(join(wiki, "sources", "a-note.md"), "utf8");
    expect(written).toContain("- [[concepts/semla]]");
    expect(written).toContain("- [[entities/otel-span]]");
  });

  it("leaves a page an earlier session wrote untouched", () => {
    const { home, wiki } = vault();
    write(join(wiki, "sources", "old-note.md"), observation("Prose."), Date.now() - 86_400_000);

    const fixes = sweepRelatedLinks({ wikiHome: home, since: Date.now(), slugs: ["semla"] });

    expect(fixes).toEqual([]);
    expect(readFileSync(join(wiki, "sources", "old-note.md"), "utf8")).not.toContain("## Related");
  });

  it("falls back to the session repo for a page that declares none", () => {
    const { home, wiki } = vault();
    write(
      join(wiki, "sources", "untagged.md"),
      observation("Prose.", "type: source\ntitle: A note"),
    );

    const fixes = sweepRelatedLinks({ wikiHome: home, since: 0, slugs: ["semla"] });

    expect(fixes).toContainEqual({ id: "sources/untagged", links: ["concepts/semla"] });
  });

  it("does nothing to a vault whose pages are already connected", () => {
    const { home, wiki } = vault();
    write(
      join(wiki, "sources", "connected.md"),
      observation("Prose. See [[concepts/semla]]."),
    );

    expect(sweepRelatedLinks({ wikiHome: home, since: 0, slugs: ["semla"] })).toEqual([]);
  });

  it("survives a vault with no page folders yet", () => {
    const home = mkdtempSync(join(tmpdir(), "related-sweep-empty-"));
    expect(sweepRelatedLinks({ wikiHome: home, since: 0, slugs: ["semla"] })).toEqual([]);
  });
});
