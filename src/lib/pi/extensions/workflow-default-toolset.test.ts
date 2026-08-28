/**
 * Subagent wiki access must not depend on the authoring model asking for it.
 *
 * Two orient runs fanned out without passing a toolset — the second even had a
 * skill telling it to — and their agents could not capture. The manager now
 * falls back to a host default, so this pins the wiring that makes that true:
 * Semla names a default, and the name resolves to tools that include capture.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import wikiIngestBridge from "./wiki-ingest-bridge.ts";
import { buildManagerOptions } from "./workflow.ts";
import { WIKI_SUBAGENT_TOOLSET } from "./wiki-subagent-tools.ts";

const EXTRA_TOOLSETS_KEY = Symbol.for("semla.workflow.extra-toolsets");
type G = Record<symbol, unknown>;

const storageStub = { load: () => undefined } as unknown as Parameters<
  typeof buildManagerOptions
>[1];

beforeEach(() => {
  delete (globalThis as G)[EXTRA_TOOLSETS_KEY];
});
afterEach(() => {
  delete (globalThis as G)[EXTRA_TOOLSETS_KEY];
});

describe("default subagent toolset", () => {
  it("names the wiki toolset as the default", () => {
    const options = buildManagerOptions(process.cwd(), storageStub);
    expect(options.defaultToolset).toBe(WIKI_SUBAGENT_TOOLSET);
  });

  // The workflow extension builds its options before the wiki bridge loads, so
  // the toolsets record has to resolve the entry lazily or the default would
  // point at nothing.
  it("resolves the default even though the bridge registers later", async () => {
    const options = buildManagerOptions(process.cwd(), storageStub);
    expect(options.toolsets[options.defaultToolset!]).toBeUndefined();

    wikiIngestBridge({ registerTool: () => {}, on: () => {} } as never);

    const resolve = options.toolsets[options.defaultToolset!];
    expect(typeof resolve).toBe("function");

    const names = () => resolve!().map((tool) => tool.name);
    // Collection is async; a run only resolves the tag long after load.
    await expect
      .poll(() => names().includes("wiki_capture_source"), { timeout: 5000 })
      .toBe(true);

    // A named toolset replaces the defaults, so the coding tools travel with it.
    expect(names()).toEqual(expect.arrayContaining(["bash", "read"]));
    // Still no recursive background starter.
    expect(names()).not.toContain("wiki_ingest");
  });
});
