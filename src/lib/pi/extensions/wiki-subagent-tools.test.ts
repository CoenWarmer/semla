/**
 * The allow/withhold split is the whole safety argument for handing wiki tools
 * to subagents, so it is asserted rather than left to the comment above it.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  collectWikiSubagentTools,
  selectSubagentTools,
  guardVaultWrites,
  normaliseTitleArgs,
  rejectUnfetchableUrl,
  WIKI_SUBAGENT_DEEP_IMPORTS,
  WIKI_SUBAGENT_REGISTRARS,
  WIKI_SUBAGENT_TOOL_NAMES,
  WIKI_SUBAGENT_TOOLSET,
  WIKI_TOOLS_WITHHELD_FROM_SUBAGENTS,
} from "./wiki-subagent-tools.ts";

/** Invoke a wrapped tool the way pi does: (toolCallId, params, ...). */
const callTool = (tool: { execute?: unknown }, params: Record<string, unknown>) =>
  (tool.execute as (...args: unknown[]) => Promise<unknown>)("call-1", params);

describe("subagent wiki tool policy", () => {
  it("never both grants and withholds the same tool", () => {
    const withheld = Object.keys(WIKI_TOOLS_WITHHELD_FROM_SUBAGENTS);
    expect(WIKI_SUBAGENT_TOOL_NAMES.filter((n) => withheld.includes(n))).toEqual([]);
  });

  // These are the recursion hazards: a subagent that can start a background
  // wiki run escapes the parent run's concurrency and budget entirely.
  it.each(["wiki_ingest", "wiki_reindex_embeddings"])(
    "withholds %s, with a stated reason",
    (tool) => {
      expect(WIKI_SUBAGENT_TOOL_NAMES).not.toContain(tool);
      expect(WIKI_TOOLS_WITHHELD_FROM_SUBAGENTS[tool]).toBeTruthy();
    },
  );

  it("grants the capture tool the whole toolset exists for", () => {
    expect(WIKI_SUBAGENT_TOOL_NAMES).toContain("wiki_capture_source");
  });

  it("declares a registrar for every granted tool", () => {
    for (const name of WIKI_SUBAGENT_TOOL_NAMES) {
      expect(WIKI_SUBAGENT_REGISTRARS[name]).toMatch(/^registerWiki/);
    }
  });

  it("uses the tag the prompt tells the agent to pass", () => {
    expect(WIKI_SUBAGENT_TOOLSET).toBe("wiki");
  });
});

describe("selectSubagentTools", () => {
  it("keeps granted tools and drops everything else", () => {
    const selected = selectSubagentTools([
      { name: "wiki_capture_source" },
      { name: "wiki_ingest" },
      { name: "wiki_status" },
    ]);

    expect(selected.map((t) => t.name)).toEqual(["wiki_capture_source", "wiki_status"]);
  });

  it("drops duplicates so a re-registered tool cannot shadow itself", () => {
    const selected = selectSubagentTools([
      { name: "wiki_status" },
      { name: "wiki_status" },
    ]);

    expect(selected).toHaveLength(1);
  });
});

// Guards the reason this broke in the first place: the tools exist, they were
// just never handed to anyone.
describe("collectWikiSubagentTools", () => {
  it("returns real tool definitions from the installed package", async () => {
    const tools = await collectWikiSubagentTools<{
      name: string;
      execute?: (...args: never[]) => unknown;
      parameters?: unknown;
    }>({}, { wikiHome: mkdtempSync(join(tmpdir(), "semla-collect-")), repoOf: () => [] });

    expect(tools.map((t) => t.name).sort()).toEqual([...WIKI_SUBAGENT_TOOL_NAMES].sort());
    for (const tool of tools) {
      expect(typeof tool.execute).toBe("function");
      expect(tool.parameters).toBeTruthy();
    }
  });

  it("declares the module it reaches into", () => {
    expect(WIKI_SUBAGENT_DEEP_IMPORTS[0]!.path).toMatch(/pi-llm-wiki.*lib\/tools\.ts$/);
  });
});

// Without a Runtime the package's capture tool rebuilds every derived file
// inline, and pi-llm-wiki allocates source ids by listing a directory. Neither
// is safe with two orient sessions in one vault.
describe("guardVaultWrites", () => {
  const guard = () => ({
    wikiHome: mkdtempSync(join(tmpdir(), "semla-guard-")),
    repoOf: () => [],
  });

  const deferredTool = (name: string, log: string[]) => ({
    name,
    async execute(id: never) {
      log.push(`start:${String(id)}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      log.push(`end:${String(id)}`);
      return id;
    },
  });

  it("never lets two vault writes overlap", async () => {
    const log: string[] = [];
    const [write] = guardVaultWrites([deferredTool("wiki_ensure_page", log)], guard());

    await Promise.all([
      write!.execute!("a" as never),
      write!.execute!("b" as never),
      write!.execute!("c" as never),
    ]);

    for (let i = 0; i < log.length; i += 2) {
      expect(log[i + 1]).toBe(log[i]!.replace("start:", "end:"));
    }
    expect(log).toHaveLength(6);
  });

  it("returns each call its own result", async () => {
    const log: string[] = [];
    const [write] = guardVaultWrites([deferredTool("wiki_ensure_page", log)], guard());

    await expect(
      Promise.all([write!.execute!("first" as never), write!.execute!("second" as never)]),
    ).resolves.toEqual(["first", "second"]);
  });

  it("releases the lock when a write throws", async () => {
    const options = guard();
    const failing = {
      name: "wiki_ensure_page",
      execute: vi
        .fn()
        .mockRejectedValueOnce(new Error("vault locked"))
        .mockResolvedValueOnce("recovered"),
    };
    const [write] = guardVaultWrites([failing], options);

    await expect(write!.execute!()).rejects.toThrow("vault locked");
    await expect(write!.execute!()).resolves.toBe("recovered");
  });

  it("leaves read-only tools unwrapped", async () => {
    const log: string[] = [];
    const [search] = guardVaultWrites([deferredTool("wiki_search", log)], guard());

    await Promise.all([search!.execute!("a" as never), search!.execute!("b" as never)]);

    expect(log.slice(0, 2)).toEqual(["start:a", "start:b"]);
  });

  // This path once failed completely silently: the session -> repo map was keyed
  // on a Supabase row id while the bridge looked up a pi runtime session id, so
  // every lookup missed and capture-time attribution did nothing at all. The
  // turn-end sweep covered for it, which is precisely why nobody noticed.
  it("says so when a capture lands with no repo", async () => {
    const wikiHome = mkdtempSync(join(tmpdir(), "semla-norepo-"));
    const dir = join(wikiHome, ".llm-wiki", "wiki", "sources");
    mkdirSync(dir, { recursive: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const capture = {
      name: "wiki_capture_source",
      execute: async () => {
        writeFileSync(join(dir, `SRC-${Date.now()}.md`), "---\ntype: source\n---\n", "utf8");
        return "ok";
      },
    };
    const [tool] = guardVaultWrites([capture], { wikiHome, repoOf: () => [] });

    await tool!.execute!();
    await tool!.execute!();

    // Filtered rather than counted: the same wrapper also rebuilds the vault
    // metadata after a capture, and this vault is a bare temp dir, so that
    // rebuild has its own opinion. The claim under test is the repo warning.
    const noRepo = warn.mock.calls.filter((call) => String(call[0]).includes("no repo"));
    expect(noRepo).toHaveLength(1);
    warn.mockRestore();
  });

  // captureFile takes no title — tools.ts calls it with the path alone and its
  // manifest hardcodes title: fileName — so a file capture is always filed
  // under a basename. Three runs produced "pi-bash-c72532dd1b9fc46a.log",
  // "semla_history.log" and a 116 KB commit history nobody could find.
  it("renames a file capture the package titled after the file", async () => {
    const wikiHome = mkdtempSync(join(tmpdir(), "semla-title-"));
    const dir = join(wikiHome, ".llm-wiki", "wiki", "sources");
    const raw = join(wikiHome, ".llm-wiki", "raw", "sources", "SRC-1");
    mkdirSync(dir, { recursive: true });
    mkdirSync(raw, { recursive: true });

    const capture = {
      name: "wiki_capture_source",
      execute: async () => {
        writeFileSync(
          join(dir, "SRC-1.md"),
          "---\ntype: source\ntitle: semla_history.log\n---\n\n# semla_history.log\n\nbody\n",
          "utf8",
        );
        writeFileSync(
          join(raw, "manifest.json"),
          JSON.stringify({ id: "SRC-1", title: "semla_history.log" }),
          "utf8",
        );
        return "ok";
      },
    };
    const [tool] = guardVaultWrites([capture], { wikiHome, repoOf: () => ["semla"] });

    await callTool(tool!, { file_path: "/tmp/semla_history.log", title: "semla History (150 commits, bodies)" });

    const page = readFileSync(join(dir, "SRC-1.md"), "utf8");
    expect(page).toContain("title: semla History (150 commits, bodies)");
    expect(page).toContain("# semla History (150 commits, bodies)");
    expect(page).not.toContain("semla_history.log");
    expect(JSON.parse(readFileSync(join(raw, "manifest.json"), "utf8")).title).toBe(
      "semla History (150 commits, bodies)",
    );
  });

  it("leaves a page the package titled sensibly alone", async () => {
    const wikiHome = mkdtempSync(join(tmpdir(), "semla-title-keep-"));
    const dir = join(wikiHome, ".llm-wiki", "wiki", "sources");
    mkdirSync(dir, { recursive: true });

    const capture = {
      name: "wiki_capture_source",
      execute: async () => {
        writeFileSync(
          join(dir, "SRC-1.md"),
          "---\ntype: source\ntitle: A Real Page Title\n---\n\n# A Real Page Title\n",
          "utf8",
        );
        return "ok";
      },
    };
    const [tool] = guardVaultWrites([capture], { wikiHome, repoOf: () => ["semla"] });

    await callTool(tool!, { file_path: "/tmp/other.log", title: "Something Else" });

    expect(readFileSync(join(dir, "SRC-1.md"), "utf8")).toContain("title: A Real Page Title");
  });

  // The point of doing this at capture rather than at turn end: the source
  // belongs to the session that captured it, not to whoever sweeps first.
  it("attributes a source page the capture just created", async () => {
    const wikiHome = mkdtempSync(join(tmpdir(), "semla-attr-"));
    const dir = join(wikiHome, ".llm-wiki", "wiki", "sources");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SRC-001.md"), "---\ntype: source\nrepo: other\n---\n", "utf8");

    const capture = {
      name: "wiki_capture_source",
      execute: async () => {
        writeFileSync(join(dir, "SRC-002.md"), "---\ntype: source\n---\n", "utf8");
        return "SRC-002";
      },
    };

    const [tool] = guardVaultWrites([capture], { wikiHome, repoOf: () => ["semla"] });
    await tool!.execute!();

    expect(readFileSync(join(dir, "SRC-002.md"), "utf8")).toContain("repo: semla");
    // A source that already existed is not re-attributed.
    expect(readFileSync(join(dir, "SRC-001.md"), "utf8")).toContain("repo: other");
  });
});

/**
 * Both of these were captured for real: a repo path handed to the web
 * extractor, stored as "Content could not be extracted", and a GitHub 404 page
 * recorded as a successful source. Neither failed loudly; both were on their
 * way into entity pages as though they described the codebase.
 */
describe("normaliseTitleArgs", () => {
  // slugify drops "/" instead of separating on it, so an owner and a repo fuse:
  // elastic/kibana became `elastickibana`, elastic/catalog-info became
  // `elasticcatalog-info`. The slug is derived inside the package and never
  // exposed, so the title is the only place this can be fixed.
  it("separates an owner from a repo", () => {
    const [, params] = normaliseTitleArgs(["call-1", { title: "elastic/kibana", text: "x" }]);

    expect(params).toEqual({ title: "elastic-kibana", text: "x" });
  });

  it("collapses a run of slashes into one dash", () => {
    const [, params] = normaliseTitleArgs(["call-1", { title: "a//b" }]);

    expect((params as { title: string }).title).toBe("a-b");
  });

  it("leaves a title with no slash untouched", () => {
    const args = ["call-1", { title: "semla History (150 commits, bodies)" }];

    expect(normaliseTitleArgs(args)[1]).toBe(args[1]);
  });

  it("leaves the other arguments in place", () => {
    const signal = Symbol("signal");
    const args = ["call-1", { title: "a/b" }, signal, undefined, { cwd: "/repo" }];

    expect(normaliseTitleArgs(args)).toHaveLength(5);
    expect(normaliseTitleArgs(args)[2]).toBe(signal);
  });

  it("does not mind a call with no params at all", () => {
    expect(() => normaliseTitleArgs(["call-1"])).not.toThrow();
  });
});

describe("rejectUnfetchableUrl", () => {
  it.each([
    ["a repo path", "/Users/coen/Dev/semla/README.md"],
    ["a relative path", "docs/plans/waterfall.md"],
    ["a file URL", "file:///Users/coen/Dev/semla/README.md"],
  ])("refuses %s", (_label, url) => {
    const refusal = rejectUnfetchableUrl({ url });

    expect(refusal?.isError).toBe(true);
    // The message has to say what to do instead, or the agent just retries.
    expect(refusal!.content[0]!.text).toContain("`text`");
  });

  it.each([
    ["an https page", "https://example.com/docs"],
    ["an http page", "http://localhost:3000/x"],
  ])("allows %s, which is a real capture", (_label, url) => {
    expect(rejectUnfetchableUrl({ url })).toBeNull();
  });

  it.each([
    ["a text capture", { text: "contents", title: "semla package.json" }],
    ["a file_path capture", { file_path: "/Users/coen/Dev/semla/README.md", title: "semla README" }],
    ["an empty url", { url: "   ", text: "contents", title: "semla package.json" }],
  ])("does not interfere with %s", (_label, params) => {
    expect(rejectUnfetchableUrl(params)).toBeNull();
  });

  // Told to pass a title, three runs still filed a facet under a name nobody
  // would search for: "pi-bash-c72532dd1b9fc46a.log", "Pasted text —
  // 2026-08-31", "semla_history.log". Each held exactly the right content.
  it.each([
    ["text", { text: "the whole git log" }],
    ["file_path", { file_path: "/tmp/semla_history.log" }],
    ["a blank title", { file_path: "/tmp/semla_history.log", title: "  " }],
  ])("refuses an untitled %s capture", (_label, params) => {
    const refusal = rejectUnfetchableUrl(params);

    expect(refusal?.isError).toBe(true);
    expect(refusal?.content[0]!.text).toContain("title");
  });

  it("still lets a web capture take its title from the page", () => {
    expect(rejectUnfetchableUrl({ url: "https://example.com/docs" })).toBeNull();
  });

  // The package reads url first and ignores everything else, so a url beside
  // real content is silent data loss rather than redundancy. An agent passed
  // "https://example.com/placeholder-and-will-be-ignored" believing the
  // opposite, and its facet was stored as the example.com landing page.
  it.each([
    ["text", { url: "https://example.com/ignored", text: "the real content" }],
    ["file_path", { url: "https://example.com/ignored", file_path: "/tmp/semla_history.log" }],
  ])("refuses a url passed alongside %s", (payload, params) => {
    const refusal = rejectUnfetchableUrl(params);

    expect(refusal?.isError).toBe(true);
    expect(refusal?.content[0]!.text).toContain("discarded");
    expect(refusal?.content[0]!.text).toContain(payload);
  });

  it("refuses before the vault lock is taken", async () => {
    const execute = vi.fn();
    const [capture] = guardVaultWrites(
      [{ name: "wiki_capture_source", execute }],
      { wikiHome: mkdtempSync(join(tmpdir(), "semla-reject-")), repoOf: () => ["semla"] },
    );

    const result = (await capture!.execute!(
      "call-1" as never,
      { url: "/Users/coen/Dev/semla/README.md" } as never,
    )) as { isError?: boolean };

    expect(result.isError).toBe(true);
    // Never reached the package, so no packet and no source id were burned.
    expect(execute).not.toHaveBeenCalled();
  });
});
