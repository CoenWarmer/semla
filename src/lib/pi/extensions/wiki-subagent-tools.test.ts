/**
 * The allow/withhold split is the whole safety argument for handing wiki tools
 * to subagents, so it is asserted rather than left to the comment above it.
 */
import { describe, expect, it } from "vitest";

import {
  collectWikiSubagentTools,
  selectSubagentTools,
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
      execute?: unknown;
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
