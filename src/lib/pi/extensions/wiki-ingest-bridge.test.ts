/**
 * Tests for wiki-ingest-bridge.ts — the layer that intercepts pi-llm-wiki
 * background operations and routes them through Semla dynamic workflows.
 *
 * We test observable side effects through globalThis symbols rather than
 * importing private helpers, matching how the bridge is actually wired at
 * runtime.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import wikiIngestBridge from "./wiki-ingest-bridge.ts";

// ── Symbol keys ──────────────────────────────────────────────────────────────

const DISPATCHER_KEY = Symbol.for("semla.wiki-ingest-dispatcher");
const REINDEX_DISPATCHER_KEY = Symbol.for("semla.wiki-reindex-dispatcher");
const EXTRA_TOOLSETS_KEY = Symbol.for("semla.workflow.extra-toolsets");
const ACTIVE_MANAGER_KEY = Symbol.for("semla.active-workflow-manager");

type G = Record<symbol, unknown>;

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMockPi() {
  return { registerTool: vi.fn(), on: vi.fn() } as unknown as Parameters<
    typeof wikiIngestBridge
  >[0];
}

function makeMockManager() {
  return { startInBackground: vi.fn().mockReturnValue({ runId: "wf_test" }) };
}

function installManager(manager: ReturnType<typeof makeMockManager>) {
  (globalThis as G)[ACTIVE_MANAGER_KEY] = manager;
}

function clearGlobals() {
  delete (globalThis as G)[ACTIVE_MANAGER_KEY];
  delete (globalThis as G)[DISPATCHER_KEY];
  delete (globalThis as G)[REINDEX_DISPATCHER_KEY];
  delete (globalThis as G)[EXTRA_TOOLSETS_KEY];
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  clearGlobals();
});

afterEach(() => {
  clearGlobals();
  vi.restoreAllMocks();
});

// ── Factory registration ──────────────────────────────────────────────────────

describe("wikiIngestBridge factory", () => {
  it("registers the ingest dispatcher in globalThis", () => {
    wikiIngestBridge(makeMockPi());
    expect(typeof (globalThis as G)[DISPATCHER_KEY]).toBe("function");
  });

  it("registers the reindex dispatcher in globalThis", () => {
    wikiIngestBridge(makeMockPi());
    expect(typeof (globalThis as G)[REINDEX_DISPATCHER_KEY]).toBe("function");
  });
});

// ── Ingest dispatcher ─────────────────────────────────────────────────────────

describe("ingest dispatcher", () => {
  it("returns false when no active manager is set", () => {
    wikiIngestBridge(makeMockPi());
    const dispatch = (globalThis as G)[DISPATCHER_KEY] as (
      sources: unknown[],
    ) => boolean;
    expect(dispatch([])).toBe(false);
  });

  it("returns true and calls startInBackground for each source", () => {
    wikiIngestBridge(makeMockPi());
    const manager = makeMockManager();
    installManager(manager);

    const dispatch = (globalThis as G)[DISPATCHER_KEY] as (
      sources: Array<{ id: string; extracted: string; manifest: Record<string, unknown> }>,
    ) => boolean;

    const sources = [
      { id: "src-1", extracted: "content one", manifest: { title: "Source One" } },
      { id: "src-2", extracted: "content two", manifest: { title: "Source Two" } },
    ];

    const result = dispatch(sources);

    expect(result).toBe(true);
    expect(manager.startInBackground).toHaveBeenCalledTimes(2);
  });

  it("passes correct args to startInBackground for a source", () => {
    wikiIngestBridge(makeMockPi());
    const manager = makeMockManager();
    installManager(manager);

    const dispatch = (globalThis as G)[DISPATCHER_KEY] as (
      sources: Array<{ id: string; extracted: string; manifest: Record<string, unknown> }>,
    ) => boolean;

    dispatch([{ id: "my-source", extracted: "some text", manifest: { title: "My Source" } }]);

    const [_script, args] = manager.startInBackground.mock.calls[0];
    expect(args).toMatchObject({ sourceId: "my-source", title: "My Source" });
    expect(typeof args.extractedContent).toBe("string");
  });

  it("registers a per-source toolset in extra-toolsets before startInBackground", () => {
    wikiIngestBridge(makeMockPi());
    const manager = makeMockManager();
    // Check toolset is registered before startInBackground resolves
    manager.startInBackground.mockImplementation(
      (_script: string, _args: unknown, opts: { toolset: string }) => {
        const extra = (globalThis as G)[EXTRA_TOOLSETS_KEY] as Record<
          string,
          () => unknown[]
        >;
        expect(extra).toBeDefined();
        expect(typeof extra[opts.toolset]).toBe("function");
        return { runId: "wf_test" };
      },
    );
    installManager(manager);

    const dispatch = (globalThis as G)[DISPATCHER_KEY] as (
      sources: Array<{ id: string; extracted: string; manifest: Record<string, unknown> }>,
    ) => boolean;
    dispatch([{ id: "x", extracted: "y", manifest: {} }]);
  });

  it("truncates long extracted content to 24 000 characters", () => {
    wikiIngestBridge(makeMockPi());
    const manager = makeMockManager();
    installManager(manager);

    const dispatch = (globalThis as G)[DISPATCHER_KEY] as (
      sources: Array<{ id: string; extracted: string; manifest: Record<string, unknown> }>,
    ) => boolean;

    const longContent = "x".repeat(50_000);
    dispatch([{ id: "big", extracted: longContent, manifest: {} }]);

    const [_script, args] = manager.startInBackground.mock.calls[0];
    expect((args as { extractedContent: string }).extractedContent.length).toBe(24_000);
  });
});

// ── Reindex dispatcher ────────────────────────────────────────────────────────

describe("reindex dispatcher", () => {
  it("returns false when no active manager is set", () => {
    wikiIngestBridge(makeMockPi());
    const dispatch = (globalThis as G)[REINDEX_DISPATCHER_KEY] as (args: unknown) => boolean;
    expect(dispatch({ paths: {}, embedder: { model: "text-emb-3" }, force: false })).toBe(false);
  });

  it("returns true and calls startInBackground with model arg", () => {
    wikiIngestBridge(makeMockPi());
    const manager = makeMockManager();
    installManager(manager);

    const dispatch = (globalThis as G)[REINDEX_DISPATCHER_KEY] as (args: {
      paths: unknown;
      embedder: { model: string; embed: unknown };
      force: boolean;
    }) => boolean;

    const result = dispatch({
      paths: {},
      embedder: { model: "text-embedding-3-small", embed: vi.fn() },
      force: false,
    });

    expect(result).toBe(true);
    expect(manager.startInBackground).toHaveBeenCalledTimes(1);
    const [_script, args] = manager.startInBackground.mock.calls[0];
    expect(args).toMatchObject({ model: "text-embedding-3-small" });
  });

  it("registers a per-run toolset with a run_reindex tool", () => {
    wikiIngestBridge(makeMockPi());
    const manager = makeMockManager();
    manager.startInBackground.mockImplementation(
      (_script: string, _args: unknown, opts: { toolset: string }) => {
        const extra = (globalThis as G)[EXTRA_TOOLSETS_KEY] as Record<
          string,
          () => Array<{ name: string }>
        >;
        expect(extra).toBeDefined();
        const tools = extra[opts.toolset]();
        expect(tools).toHaveLength(1);
        expect(tools[0].name).toBe("run_reindex");
        return { runId: "wf_test" };
      },
    );
    installManager(manager);

    const dispatch = (globalThis as G)[REINDEX_DISPATCHER_KEY] as (args: {
      paths: unknown;
      embedder: { model: string; embed: unknown };
      force: boolean;
    }) => boolean;

    dispatch({ paths: {}, embedder: { model: "text-emb-3", embed: vi.fn() }, force: true });
  });

  it("uses a unique toolset key per call", () => {
    wikiIngestBridge(makeMockPi());
    const manager = makeMockManager();
    installManager(manager);

    const dispatch = (globalThis as G)[REINDEX_DISPATCHER_KEY] as (args: {
      paths: unknown;
      embedder: { model: string; embed: unknown };
      force: boolean;
    }) => boolean;

    dispatch({ paths: {}, embedder: { model: "emb-1", embed: vi.fn() }, force: false });
    dispatch({ paths: {}, embedder: { model: "emb-2", embed: vi.fn() }, force: false });

    const key1 = (manager.startInBackground.mock.calls[0][2] as { toolset: string }).toolset;
    const key2 = (manager.startInBackground.mock.calls[1][2] as { toolset: string }).toolset;
    expect(key1).not.toBe(key2);
  });
});
