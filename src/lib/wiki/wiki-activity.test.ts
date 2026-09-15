/**
 * The overlay silently stopped appearing when capture moved into subagents,
 * because its only trigger was a tool the main session no longer calls. These
 * pin the tools that still reach the main stream during a real orient.
 */
import { describe, expect, it } from "vitest";

import { startsWikiActivity, WIKI_ACTIVITY_TOOLS } from "./wiki-activity.ts";

describe("startsWikiActivity", () => {
  // The fan-out path: the main agent's only wiki write is the ingest call.
  it("triggers on wiki_ingest", () => {
    expect(startsWikiActivity("wiki_ingest")).toBe(true);
  });

  it.each(["wiki_bootstrap", "wiki_init", "wiki_capture_source"])(
    "still triggers on %s, for orients that never fan out",
    (tool) => {
      expect(startsWikiActivity(tool)).toBe(true);
    },
  );

  // These all appear in a normal orient before any wiki page exists; treating
  // them as activity would raise an overlay over an empty graph.
  it.each(["wiki_recall", "wiki_status", "workflow", "bash", "read"])(
    "does not trigger on %s",
    (tool) => {
      expect(startsWikiActivity(tool)).toBe(false);
    },
  );

  it("has no duplicate entries", () => {
    expect(new Set(WIKI_ACTIVITY_TOOLS).size).toBe(WIKI_ACTIVITY_TOOLS.length);
  });
});
