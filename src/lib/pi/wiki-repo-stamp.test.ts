/**
 * The stamper is the only thing standing between an orient run and a wiki page
 * that claims to belong to whichever repo the vault happens to be named after,
 * so the frontmatter surgery is pinned down here rather than trusted.
 */
import { mkdtempSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildSourceRepoIndex,
  extractSourceIds,
  lineageRepo,
  repoSlugFromProjectPath,
  stampRepoFrontmatter,
  stampSessionWikiPages,
  stampWikiPages,
} from "./wiki-repo-stamp.ts";

describe("repoSlugFromProjectPath", () => {
  it("reduces a project path to its directory name", () => {
    expect(repoSlugFromProjectPath("/Users/coen/Dev/react-otel-trace-waterfall")).toBe(
      "react-otel-trace-waterfall",
    );
  });

  it("ignores a trailing separator", () => {
    expect(repoSlugFromProjectPath("/Users/coen/Dev/semla/")).toBe("semla");
  });

  it.each([null, undefined, "", "/"])("has no slug for %s", (value) => {
    expect(repoSlugFromProjectPath(value)).toBeNull();
  });
});

describe("stampRepoFrontmatter", () => {
  const page = (front: string, body = "\n# Heading\n\nText.\n") =>
    `---\n${front}\n---\n${body}`;

  it("adds repo as the last frontmatter field", () => {
    const input = page("type: concept\ntitle: Thing\ncreated: 2026-08-28");
    const { changed, content } = stampRepoFrontmatter(input, "buildkite-tray");

    expect(changed).toBe(true);
    expect(content).toBe(
      page("type: concept\ntitle: Thing\ncreated: 2026-08-28\nrepo: buildkite-tray"),
    );
  });

  it("leaves a page that already declares a repo alone", () => {
    const input = page("type: concept\ntitle: Thing\nrepo: other-repo");
    const { changed, content } = stampRepoFrontmatter(input, "semla");

    expect(changed).toBe(false);
    expect(content).toBe(input);
  });

  it("preserves a multi-repo list", () => {
    const input = page("type: concept\nrepo: [semla, ecs]");

    expect(stampRepoFrontmatter(input, "semla").changed).toBe(false);
  });

  // Every page in the real vault that carried repo: had it in a second block
  // like this, where the parser reads it as body text and the registry never
  // sees it. The value was the session's absolute path, not a slug.
  it("absorbs an orphan repo block and reduces its path to a slug", () => {
    const input = [
      "---",
      "type: concept",
      "title: elastic-evals CLI and suites",
      "updated: 2026-08-28",
      "---",
      "",
      "---",
      "repo: /Users/coen/Dev/elastic-evals-sdk-python",
      "---",
      "",
      "# elastic-evals CLI and suites",
      "",
    ].join("\n");

    const { changed, content } = stampRepoFrontmatter(input, "some-other-repo");

    expect(changed).toBe(true);
    // The page's own claim wins over the session's — it named a real repo.
    expect(content).toBe(
      [
        "---",
        "type: concept",
        "title: elastic-evals CLI and suites",
        "updated: 2026-08-28",
        "repo: elastic-evals-sdk-python",
        "---",
        "",
        "# elastic-evals CLI and suites",
        "",
      ].join("\n"),
    );
  });

  // The other shape in the real vault: the orphan block repeats type/title as
  // well. Stamping the session slug over it would relabel a buildkite-tray page
  // as whichever repo the session happened to be about.
  it("adopts the repo from a duplicated frontmatter block and drops the block", () => {
    const input = [
      "---",
      "type: concept",
      "title: buildkite-tray-main-process",
      "updated: 2026-08-28",
      "---",
      "",
      "---",
      "repo: /Users/coen/Dev/buildkite-tray",
      "type: concept",
      "title: buildkite-tray-main-process",
      "---",
      "",
      "# buildkite-tray main process",
      "",
    ].join("\n");

    const { content } = stampRepoFrontmatter(input, "react-otel-trace-waterfall");

    expect(content).toContain("repo: buildkite-tray");
    expect(content).not.toContain("react-otel-trace-waterfall");
    expect(content.split("\n").filter((l) => l.trim() === "---")).toHaveLength(2);
    expect(content).toContain("# buildkite-tray main process");
  });

  it("keeps the block but still adopts its repo when it holds page content", () => {
    const input = [
      "---",
      "type: concept",
      "---",
      "",
      "---",
      "repo: /Users/coen/Dev/thing",
      "Some prose that is not frontmatter at all.",
      "---",
      "",
    ].join("\n");

    const { content } = stampRepoFrontmatter(input, "semla");

    expect(content).toContain("Some prose that is not frontmatter at all.");
    expect(content.split("\n").slice(0, 4)).toEqual([
      "---",
      "type: concept",
      "repo: thing",
      "---",
    ]);
  });

  // The placement is the whole point: repo: has to sit inside the first fenced
  // block, because that is the only one pi-llm-wiki parses. Landing it anywhere
  // else is the exact bug that made every page render as the vault's own name.
  it.each([
    ["a page with no repo", page("type: concept\ntitle: Thing")],
    [
      "a page with an orphan repo block",
      "---\ntype: concept\n---\n\n---\nrepo: /Users/coen/Dev/thing\n---\n\n# Thing\n",
    ],
  ])("puts repo inside the one real frontmatter block for %s", (_label, input) => {
    const lines = stampRepoFrontmatter(input, "semla").content.split("\n");
    const fences = lines.flatMap((line, i) => (line.trim() === "---" ? [i] : []));
    const repoLine = lines.findIndex((line) => /^repo\s*:/.test(line));

    expect(fences.length, "exactly one frontmatter block should remain").toBe(2);
    expect(fences[0]).toBe(0);
    expect(repoLine).toBeGreaterThan(fences[0]!);
    expect(repoLine).toBeLessThan(fences[1]!);
    // One repo field, not one per attempt.
    expect(lines.filter((line) => /^repo\s*:/.test(line))).toHaveLength(1);
  });

  it("is idempotent", () => {
    const input = page("type: entity\ntitle: Thing");
    const once = stampRepoFrontmatter(input, "semla").content;
    const twice = stampRepoFrontmatter(once, "semla");

    expect(twice.changed).toBe(false);
    expect(twice.content).toBe(once);
  });

  it.each([
    ["a page with no frontmatter", "# Just a heading\n"],
    ["an unterminated frontmatter block", "---\ntype: concept\n"],
  ])("leaves %s untouched", (_label, input) => {
    expect(stampRepoFrontmatter(input, "semla")).toEqual({
      changed: false,
      content: input,
      repo: null,
    });
  });
});

describe("stampWikiPages", () => {
  const vault = () => {
    const home = mkdtempSync(join(tmpdir(), "semla-wiki-"));
    mkdirSync(join(home, ".llm-wiki", "wiki", "concepts"), { recursive: true });
    mkdirSync(join(home, ".llm-wiki", "wiki", "entities"), { recursive: true });
    return home;
  };

  const write = (home: string, rel: string, content: string, mtime?: number) => {
    const path = join(home, ".llm-wiki", "wiki", rel);
    writeFileSync(path, content, "utf8");
    if (mtime !== undefined) utimesSync(path, mtime / 1000, mtime / 1000);
    return path;
  };

  it("stamps only pages written since the cutoff", () => {
    const home = vault();
    const since = Date.now();
    const stale = write(home, "concepts/old.md", "---\ntype: concept\n---\n", since - 60_000);
    const fresh = write(home, "concepts/new.md", "---\ntype: concept\n---\n");

    const stamped = stampWikiPages({ slug: "semla", since, wikiHome: home });

    expect(stamped).toEqual([{ id: "concepts/new", repo: "semla" }]);
    expect(readFileSync(fresh, "utf8")).toContain("repo: semla");
    // A page from an earlier orient of another repo keeps its own story.
    expect(readFileSync(stale, "utf8")).not.toContain("repo:");
  });

  it("walks every page folder and skips the generated index", () => {
    const home = vault();
    write(home, "entities/thing.md", "---\ntype: entity\n---\n");
    write(home, "concepts/index.md", "---\ntype: concept\n---\n");

    const stamped = stampWikiPages({ slug: "semla", since: 0, wikiHome: home });

    expect(stamped).toEqual([{ id: "entities/thing", repo: "semla" }]);
  });

  it("reports nothing when every page is already tagged", () => {
    const home = vault();
    write(home, "concepts/tagged.md", "---\ntype: concept\nrepo: other\n---\n");

    expect(stampWikiPages({ slug: "semla", since: 0, wikiHome: home })).toEqual([]);
  });
});

// The graph reads meta/registry.json, not the pages, so a stamp that never
// reaches the registry is invisible no matter how correct the frontmatter is.
describe("stampSessionWikiPages", () => {
  const vaultWithRegistry = (pages: Record<string, unknown>) => {
    const home = mkdtempSync(join(tmpdir(), "semla-wiki-reg-"));
    mkdirSync(join(home, ".llm-wiki", "wiki", "concepts"), { recursive: true });
    mkdirSync(join(home, ".llm-wiki", "meta"), { recursive: true });
    writeFileSync(
      join(home, ".llm-wiki", "meta", "registry.json"),
      `${JSON.stringify({ version: "1.0", pages }, null, 2)}\n`,
      "utf8",
    );
    return home;
  };

  const registryOf = (home: string) =>
    JSON.parse(
      readFileSync(join(home, ".llm-wiki", "meta", "registry.json"), "utf8"),
    ) as { pages: Record<string, { repo?: string | string[]; title?: string }> };

  it("writes the stamped repo into the registry entry", async () => {
    const home = vaultWithRegistry({
      "concepts/thing": { type: "concept", title: "Thing" },
    });
    writeFileSync(
      join(home, ".llm-wiki", "wiki", "concepts", "thing.md"),
      "---\ntype: concept\ntitle: Thing\n---\n",
      "utf8",
    );

    const stamped = await stampSessionWikiPages({
      projectPath: "/Users/coen/Dev/react-otel-trace-waterfall",
      since: 0,
      wikiHome: home,
    });

    expect(stamped).toEqual([
      { id: "concepts/thing", repo: "react-otel-trace-waterfall" },
    ]);
    const entry = registryOf(home).pages["concepts/thing"]!;
    expect(entry.repo).toBe("react-otel-trace-waterfall");
    // The patch must not clobber the rest of the entry.
    expect(entry.title).toBe("Thing");
  });

  it("records a multi-repo page as a list, matching WikiPageMeta", async () => {
    const home = vaultWithRegistry({ "concepts/shared": { type: "concept" } });
    writeFileSync(
      join(home, ".llm-wiki", "wiki", "concepts", "shared.md"),
      "---\ntype: concept\n---\n\n---\nrepo: [semla, ecs]\n---\n",
      "utf8",
    );

    await stampSessionWikiPages({ projectPath: "/Dev/other", since: 0, wikiHome: home });

    expect(registryOf(home).pages["concepts/shared"]!.repo).toEqual(["semla", "ecs"]);
  });

  it("does nothing without a project path", async () => {
    const home = vaultWithRegistry({ "concepts/thing": { type: "concept" } });
    writeFileSync(
      join(home, ".llm-wiki", "wiki", "concepts", "thing.md"),
      "---\ntype: concept\n---\n",
      "utf8",
    );

    expect(await stampSessionWikiPages({ projectPath: null, since: 0, wikiHome: home })).toEqual([]);
    expect(registryOf(home).pages["concepts/thing"]!.repo).toBeUndefined();
  });
});

// The bug this exists to kill: two orient sessions sharing one vault, where the
// sweep stamped 63 semla pages as buildkite-tray purely because that session's
// turn ended first.
describe("lineage attribution", () => {
  const page = (ids: string[]) =>
    [
      "---",
      "type: concept",
      "title: Thing",
      ...(ids.length
        ? ["sources:", ...ids.flatMap((id) => [`  - id: ${id}`, `    resource: /sources/${id}.md`])]
        : []),
      "---",
      "",
      "# Thing",
      "",
      "Mentions SRC-2026-08-28-999 in prose, which is not lineage.",
      "",
    ].join("\n");

  it("reads source ids from frontmatter only, not the body", () => {
    expect(extractSourceIds(page(["SRC-2026-08-28-003"]))).toEqual(["SRC-2026-08-28-003"]);
  });

  it("has no lineage for a page with no sources", () => {
    expect(lineageRepo(page([]), new Map())).toBeNull();
  });

  it("inherits the repo of the source it was synthesised from", () => {
    const index = new Map([["SRC-2026-08-28-003", "semla"]]);
    expect(lineageRepo(page(["SRC-2026-08-28-003"]), index)).toBe("semla");
  });

  it("becomes a list when a page genuinely spans repos", () => {
    const index = new Map([
      ["SRC-2026-08-28-003", "semla"],
      ["SRC-2026-08-28-009", "buildkite-tray"],
    ]);
    expect(lineageRepo(page(["SRC-2026-08-28-003", "SRC-2026-08-28-009"]), index)).toBe(
      "[buildkite-tray, semla]",
    );
  });

  it("indexes source pages by their declared repo", () => {
    const home = mkdtempSync(join(tmpdir(), "semla-lineage-"));
    mkdirSync(join(home, "sources"), { recursive: true });
    writeFileSync(
      join(home, "sources", "SRC-2026-08-28-001.md"),
      "---\ntype: source\nrepo: semla\n---\n",
      "utf8",
    );
    writeFileSync(
      join(home, "sources", "SRC-2026-08-28-005.md"),
      "---\ntype: source\n---\n",
      "utf8",
    );

    const index = buildSourceRepoIndex(home);
    expect(index.get("SRC-2026-08-28-001")).toBe("semla");
    expect(index.has("SRC-2026-08-28-005")).toBe(false);
  });

  it("does not claim another session's pages for the session that swept last", () => {
    const home = mkdtempSync(join(tmpdir(), "semla-concurrent-"));
    const wiki = join(home, ".llm-wiki", "wiki");
    mkdirSync(join(wiki, "sources"), { recursive: true });
    mkdirSync(join(wiki, "concepts"), { recursive: true });

    // A source captured by the semla session, already attributed.
    writeFileSync(
      join(wiki, "sources", "SRC-2026-08-28-001.md"),
      "---\ntype: source\nrepo: semla\n---\n",
      "utf8",
    );
    // Its derived page, written while the buildkite-tray turn was open.
    writeFileSync(
      join(wiki, "concepts", "from-semla.md"),
      page(["SRC-2026-08-28-001"]),
      "utf8",
    );
    // A page with no lineage, which the sweeping session does own.
    writeFileSync(join(wiki, "concepts", "hand-written.md"), page([]), "utf8");

    const stamped = stampWikiPages({ slug: "buildkite-tray", since: 0, wikiHome: home });
    const byId = new Map(stamped.map((p) => [p.id, p.repo]));

    expect(byId.get("concepts/from-semla")).toBe("semla");
    expect(byId.get("concepts/hand-written")).toBe("buildkite-tray");
  });
});
