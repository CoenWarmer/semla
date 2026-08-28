/**
 * The allow/withhold split is the whole safety argument for handing wiki tools
 * to subagents, so it is asserted rather than left to the comment above it.
 */
import { describe, expect, it, vi } from "vitest";

import {
  collectWikiSubagentTools,
  selectSubagentTools,
  serializeVaultWrites,
  WIKI_SUBAGENT_DEEP_IMPORTS,
  WIKI_SUBAGENT_REGISTRARS,
  WIKI_SUBAGENT_TOOL_NAMES,
  WIKI_SUBAGENT_TOOLSET,
  WIKI_TOOLS_WITHHELD_FROM_SUBAGENTS,
} from "./wiki-subagent-tools.ts";

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
    }>({});

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
// inline, with none of scheduleReindex's coalescing. Parallel capture agents
// must therefore not be inside that rebuild at the same time.
describe("serializeVaultWrites", () => {
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
    const [capture] = serializeVaultWrites([deferredTool("wiki_capture_source", log)]);

    await Promise.all([
      capture!.execute!("a" as never),
      capture!.execute!("b" as never),
      capture!.execute!("c" as never),
    ]);

    expect(log).toEqual([
      "start:a", "end:a",
      "start:b", "end:b",
      "start:c", "end:c",
    ]);
  });

  it("returns each call its own result, in order", async () => {
    const log: string[] = [];
    const [capture] = serializeVaultWrites([deferredTool("wiki_capture_source", log)]);

    const results = await Promise.all([
      capture!.execute!("first" as never),
      capture!.execute!("second" as never),
    ]);

    expect(results).toEqual(["first", "second"]);
  });

  it("keeps the queue alive after a failed write", async () => {
    const failing = {
      name: "wiki_capture_source",
      execute: vi
        .fn()
        .mockRejectedValueOnce(new Error("vault locked"))
        .mockResolvedValueOnce("recovered"),
    };
    const [capture] = serializeVaultWrites([failing]);

    await expect(capture!.execute!()).rejects.toThrow("vault locked");
    await expect(capture!.execute!()).resolves.toBe("recovered");
  });

  it("leaves read-only tools running concurrently", async () => {
    const log: string[] = [];
    const [search] = serializeVaultWrites([deferredTool("wiki_search", log)]);

    await Promise.all([
      search!.execute!("a" as never),
      search!.execute!("b" as never),
    ]);

    // Interleaved, because nothing was wrapped.
    expect(log.slice(0, 2)).toEqual(["start:a", "start:b"]);
  });
});
