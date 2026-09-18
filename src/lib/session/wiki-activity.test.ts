import { describe, expect, it } from "vitest";

import {
  deriveWikiActivity,
  hasWikiActivity,
  NO_WIKI_ACTIVITY,
  pageIdFromPath,
  parseRecalledPages,
} from "@/lib/session/wiki-activity";

describe("pageIdFromPath", () => {
  it("pulls folder/slug out of an absolute vault path", () => {
    expect(
      pageIdFromPath(
        "/Users/coen/Dev/semla/.semla-wiki/.llm-wiki/wiki/concepts/single-user-mode.md",
      ),
    ).toBe("concepts/single-user-mode");
  });

  it("anchors on the vault directory, not a machine-specific prefix", () => {
    // A transcript recorded on one machine is read on another, so the
    // absolute prefix cannot be part of the match.
    expect(pageIdFromPath("/elsewhere/.llm-wiki/wiki/entities/foo.md")).toBe(
      "entities/foo",
    );
    expect(pageIdFromPath(".llm-wiki/wiki/sources/bar.md")).toBe("sources/bar");
  });

  it("accepts a page with no extension and an .mdx one", () => {
    expect(pageIdFromPath(".llm-wiki/wiki/concepts/foo")).toBe("concepts/foo");
    expect(pageIdFromPath(".llm-wiki/wiki/concepts/foo.mdx")).toBe("concepts/foo");
  });

  it("normalizes windows separators", () => {
    expect(pageIdFromPath(String.raw`C:\v\.llm-wiki\wiki\concepts\foo.md`)).toBe(
      "concepts/foo",
    );
  });

  it("rejects a path outside the vault", () => {
    expect(pageIdFromPath("src/lib/session/wiki-activity.ts")).toBeNull();
    expect(pageIdFromPath("docs/plans/session-summary-card.md")).toBeNull();
  });

  it("rejects vault files that are not pages", () => {
    // meta/ and the vault's own config are not pages, and a nested path is
    // not one either.
    expect(pageIdFromPath(".llm-wiki/wiki/meta/log.md")).toBeNull();
    expect(pageIdFromPath(".llm-wiki/wiki/concepts/nested/foo.md")).toBeNull();
    expect(pageIdFromPath(".llm-wiki/wiki/concepts/")).toBeNull();
  });
});

describe("parseRecalledPages", () => {
  // The real injected block, from a transcript in .semla-sessions/.
  const injection = [
    "## Relevant Wiki Knowledge (links-first)",
    "",
    "_3 page(s) matched your query, ranked._",
    "",
    "1. **[[concepts/entity-canonicalization]]** — *concept* — score 48.4 — Entity Canonicalization — #Entity Canonicalization — Process to prevent…",
    "2. **[[concepts/single-user-mode]]** — *concept* — score 36.0 — Single-user mode — #Single-user mode — Default operating mode…",
    "3. **[[concepts/foldeventsintoparent]]** — *concept* — score 31.2 — foldEventsIntoParent — #foldEventsIntoParent — Library feature…",
    "",
    "Call `read` on the exact path shown under each link.",
  ].join("\n");

  it("reads every hit's id and title", () => {
    expect(parseRecalledPages(injection)).toEqual([
      {
        folder: "concepts",
        id: "concepts/entity-canonicalization",
        label: "Entity Canonicalization",
      },
      { folder: "concepts", id: "concepts/single-user-mode", label: "Single-user mode" },
      {
        folder: "concepts",
        id: "concepts/foldeventsintoparent",
        label: "foldEventsIntoParent",
      },
    ]);
  });

  it("falls back to the slug when a line carries no title", () => {
    // The injection is a presentation format built for a model to read, so a
    // reworded recall must cost the label, not the page.
    expect(parseRecalledPages("1. **[[concepts/foo]]** — *concept*")).toEqual([
      { folder: "concepts", id: "concepts/foo", label: "foo" },
    ]);
  });

  it("ignores a line with no wikilink, and a malformed target", () => {
    expect(parseRecalledPages("no links here\n_3 page(s) matched_")).toEqual([]);
    expect(parseRecalledPages("1. **[[notapath]]**")).toEqual([]);
    expect(parseRecalledPages("1. **[[concepts/]]**")).toEqual([]);
  });

  it("returns nothing for empty content rather than throwing", () => {
    expect(parseRecalledPages("")).toEqual([]);
  });
});

describe("deriveWikiActivity", () => {
  it("separates pages offered, opened and written", () => {
    const activity = deriveWikiActivity({
      messages: [
        {
          createdAt: "2026-09-17T10:00:00Z",
          wikiRecall: "1. **[[concepts/a]]** — *concept* — score 9.0 — Page A —",
        },
      ],
      toolCalls: [
        {
          createdAt: "2026-09-17T10:01:00Z",
          name: "read",
          params: { path: "/v/.llm-wiki/wiki/concepts/a.md" },
        },
        {
          createdAt: "2026-09-17T10:02:00Z",
          name: "wiki_ensure_page",
          params: { title: "Session Summary Card", type: "concept" },
        },
      ],
    });

    // The same page is both offered and opened — the case that shows recall
    // paid off — so it appears in both, not one.
    expect(activity.recalled).toEqual([
      { folder: "concepts", id: "concepts/a", label: "Page A" },
    ]);
    expect(activity.read).toEqual([
      { folder: "concepts", id: "concepts/a", label: "a" },
    ]);
    expect(activity.written).toEqual([
      {
        folder: "concepts",
        id: "concepts/session-summary-card",
        label: "Session Summary Card",
      },
    ]);
  });

  it("ignores reads of files outside the vault", () => {
    const activity = deriveWikiActivity({
      messages: [],
      toolCalls: [
        { createdAt: "t", name: "read", params: { path: "src/lib/utils.ts" } },
      ],
    });
    expect(activity).toEqual(NO_WIKI_ACTIVITY);
  });

  it("skips a failed call: it neither opened nor created anything", () => {
    const activity = deriveWikiActivity({
      messages: [],
      toolCalls: [
        {
          createdAt: "t",
          isError: true,
          name: "read",
          params: { path: "/v/.llm-wiki/wiki/concepts/a.md" },
        },
        {
          createdAt: "t",
          isError: true,
          name: "wiki_ensure_page",
          params: { title: "Never Created", type: "concept" },
        },
      ],
    });
    expect(activity).toEqual(NO_WIKI_ACTIVITY);
  });

  it("does not count capture or background tools as pages written", () => {
    // wiki_capture_source is the input half of the pipeline; ingest/lint write
    // from a worker the transcript cannot see.
    const activity = deriveWikiActivity({
      messages: [],
      toolCalls: [
        { createdAt: "t", name: "wiki_capture_source", params: { url: "https://x" } },
        { createdAt: "t", name: "wiki_ingest", params: { batch_size: "5" } },
        { createdAt: "t", name: "wiki_lint", params: {} },
        { createdAt: "t", name: "wiki_status", params: {} },
      ],
    });
    expect(activity.written).toEqual([]);
  });

  it("files an observation and a retro under sources", () => {
    const activity = deriveWikiActivity({
      messages: [],
      toolCalls: [
        { createdAt: "t", name: "wiki_observe", params: { title: "A Thing Happened" } },
        { createdAt: "t", name: "wiki_retro", params: { slug: "kept-slug", title: "T" } },
      ],
    });
    expect(activity.written.map((page) => page.id)).toEqual([
      // Newest first: the retro was the later call.
      "sources/kept-slug",
      "sources/a-thing-happened",
    ]);
  });

  it("maps a page type to its folder, falling back to concepts", () => {
    const folderFor = (type: string) =>
      deriveWikiActivity({
        messages: [],
        toolCalls: [
          { createdAt: "t", name: "wiki_ensure_page", params: { title: "X", type } },
        ],
      }).written[0]?.folder;

    expect(folderFor("entity")).toBe("entities");
    expect(folderFor("analysis")).toBe("analyses");
    // `person` and `organisation` have no folder of their own — the package
    // files them under concepts, which is what the wiki guidelines describe.
    expect(folderFor("person")).toBe("concepts");
    expect(folderFor("organisation")).toBe("concepts");
  });

  it("dedupes repeated reads of one page and prefers a real title", () => {
    const activity = deriveWikiActivity({
      messages: [
        { createdAt: "t", wikiRecall: "1. **[[concepts/a]]** — *c* — score 1.0 — Real Title —" },
        { createdAt: "t", wikiRecall: "1. **[[concepts/a]]** — *c*" },
      ],
      toolCalls: [
        { createdAt: "t", name: "read", params: { path: ".llm-wiki/wiki/concepts/a.md" } },
        { createdAt: "t", name: "read", params: { path: ".llm-wiki/wiki/concepts/a.md" } },
      ],
    });

    expect(activity.read).toHaveLength(1);
    expect(activity.recalled).toHaveLength(1);
    expect(activity.recalled[0].label).toBe("Real Title");
  });

  it("orders newest first", () => {
    const activity = deriveWikiActivity({
      messages: [],
      toolCalls: [
        { createdAt: "t1", name: "read", params: { path: ".llm-wiki/wiki/concepts/old.md" } },
        { createdAt: "t2", name: "read", params: { path: ".llm-wiki/wiki/concepts/new.md" } },
      ],
    });
    expect(activity.read.map((page) => page.id)).toEqual([
      "concepts/new",
      "concepts/old",
    ]);
  });

  it("handles a call with no params", () => {
    const activity = deriveWikiActivity({
      messages: [],
      toolCalls: [
        { createdAt: "t", name: "read" },
        { createdAt: "t", name: "wiki_ensure_page" },
        { createdAt: "t", name: "wiki_observe", params: {} },
      ],
    });
    expect(activity).toEqual(NO_WIKI_ACTIVITY);
  });
});

describe("hasWikiActivity", () => {
  it("is false for an empty activity and true for any populated one", () => {
    expect(hasWikiActivity(NO_WIKI_ACTIVITY)).toBe(false);
    expect(
      hasWikiActivity({
        ...NO_WIKI_ACTIVITY,
        recalled: [{ folder: "concepts", id: "concepts/a", label: "a" }],
      }),
    ).toBe(true);
  });
});
