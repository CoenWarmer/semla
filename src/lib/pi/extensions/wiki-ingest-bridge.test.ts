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
const BRIDGE_RUN_STARTED_KEY = Symbol.for("semla.bridge-run-started");

type G = Record<symbol, unknown>;

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMockPi() {
  return { registerTool: vi.fn(), on: vi.fn() } as unknown as Parameters<
    typeof wikiIngestBridge
  >[0];
}

/** A pi whose session_start handlers can be fired with a chosen session id. */
function makeSessionPi(sessionId: string) {
  const handlers: Array<(event: unknown, ctx: unknown) => void> = [];
  const pi = {
    registerTool: vi.fn(),
    on: vi.fn((event: string, handler: (e: unknown, c: unknown) => void) => {
      if (event === "session_start") handlers.push(handler);
    }),
  } as unknown as Parameters<typeof wikiIngestBridge>[0];

  return {
    pi,
    // Awaited, as pi awaits its session_start handlers: the bridge gathers the
    // wiki tools there so a run cannot start before they exist.
    start: async () => {
      for (const handler of handlers) {
        await handler(undefined, { sessionManager: { getSessionId: () => sessionId } });
      }
    },
  };
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
  delete (globalThis as G)[BRIDGE_RUN_STARTED_KEY];
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

  // Subagents used to get bash/read/edit/write and nothing else, so a workflow
  // told to capture sources could not call wiki_capture_source at all.
  it("publishes a wiki toolset carrying the real capture tool", async () => {
    wikiIngestBridge(makeMockPi());

    const toolsets = (globalThis as G)[EXTRA_TOOLSETS_KEY] as Record<
      string,
      () => Array<{ name: string }>
    >;
    expect(typeof toolsets.wiki).toBe("function");

    // Collection is async and memoised; the manager only resolves the tag long
    // after extension load, so let the cache warm the way it does in a session.
    await vi.waitFor(() => {
      expect(toolsets.wiki!().map((t) => t.name)).toContain("wiki_capture_source");
    });

    const names = toolsets.wiki!().map((t) => t.name);
    // A named toolset replaces the defaults, so the coding tools must come too.
    expect(names).toContain("bash");
    expect(names).toContain("read");
    // Recursion hazard: a subagent must not be able to start its own wiki run.
    expect(names).not.toContain("wiki_ingest");
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

  it("returns true and calls startInBackground once per batch (not per source)", () => {
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
    // One coordinator workflow per wiki_ingest call, regardless of source count.
    expect(manager.startInBackground).toHaveBeenCalledTimes(1);
  });

  it("passes all sources as a parallel-ready array to startInBackground", () => {
    wikiIngestBridge(makeMockPi());
    const manager = makeMockManager();
    installManager(manager);

    const dispatch = (globalThis as G)[DISPATCHER_KEY] as (
      sources: Array<{ id: string; extracted: string; manifest: Record<string, unknown> }>,
    ) => boolean;

    dispatch([{ id: "my-source", extracted: "some text", manifest: { title: "My Source" } }]);

    const [_script, args] = manager.startInBackground.mock.calls[0] as [
      string,
      { sources: Array<{ sourceId: string; title: string; extractedContent: string }> },
    ];
    expect(args.sources).toHaveLength(1);
    expect(args.sources[0]).toMatchObject({ sourceId: "my-source", title: "My Source" });
    expect(typeof args.sources[0].extractedContent).toBe("string");
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

  it("calls the bridge run notifier once per batch with primary:true", () => {
    wikiIngestBridge(makeMockPi());
    const manager = makeMockManager();
    installManager(manager);

    const notifier = vi.fn();
    (globalThis as G)[BRIDGE_RUN_STARTED_KEY] = notifier;

    const dispatch = (globalThis as G)[DISPATCHER_KEY] as (
      sources: Array<{ id: string; extracted: string; manifest: Record<string, unknown> }>,
    ) => boolean;
    dispatch([
      { id: "a", extracted: "x", manifest: {} },
      { id: "b", extracted: "y", manifest: {} },
    ]);

    // One notifier call per coordinator workflow, not per source.
    expect(notifier).toHaveBeenCalledTimes(1);
    const [runId, opts] = notifier.mock.calls[0] as [string, { primary?: boolean }];
    expect(typeof runId).toBe("string");
    expect(opts?.primary).toBe(true);
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

    const [_script, args] = manager.startInBackground.mock.calls[0] as [
      string,
      { sources: Array<{ extractedContent: string }> },
    ];
    expect(args.sources[0].extractedContent.length).toBe(24_000);
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

  it("calls the bridge run notifier with the returned runId", () => {
    wikiIngestBridge(makeMockPi());
    const manager = makeMockManager();
    manager.startInBackground.mockReturnValue({ runId: "wf_reindex_test", promise: Promise.resolve() });
    installManager(manager);

    const notifier = vi.fn();
    (globalThis as G)[BRIDGE_RUN_STARTED_KEY] = notifier;

    const dispatch = (globalThis as G)[REINDEX_DISPATCHER_KEY] as (args: {
      paths: unknown;
      embedder: { model: string; embed: unknown };
      force: boolean;
    }) => boolean;
    dispatch({ paths: {}, embedder: { model: "emb", embed: vi.fn() }, force: false });

    expect(notifier).toHaveBeenCalledWith("wf_reindex_test");
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

/**
 * Three concurrent orients attributed all 168 of their pages to one repo,
 * because the toolset map is process-wide and a fixed "wiki" key meant the last
 * session to load overwrote every earlier one — every subagent then held the
 * tools, and the repo, of whichever session happened to be last.
 *
 * Every check before this one ran a single session, which is exactly why the
 * bug survived two rounds of fixes.
 */
describe("concurrent sessions", () => {
  const toolsets = () =>
    ((globalThis as G)[EXTRA_TOOLSETS_KEY] ?? {}) as Record<string, () => unknown[]>;

  it("gives each session its own toolset entry", async () => {
    const first = makeSessionPi("session-a");
    const second = makeSessionPi("session-b");

    wikiIngestBridge(first.pi);
    await first.start();
    wikiIngestBridge(second.pi);
    await second.start();

    expect(Object.keys(toolsets()).sort()).toEqual(
      expect.arrayContaining(["wiki", "wiki:session-a", "wiki:session-b"]),
    );
  });

  it("does not let a later session replace an earlier one's entry", async () => {
    const first = makeSessionPi("session-a");
    wikiIngestBridge(first.pi);
    await first.start();
    const earlier = toolsets()["wiki:session-a"];

    const second = makeSessionPi("session-b");
    wikiIngestBridge(second.pi);
    await second.start();

    expect(toolsets()["wiki:session-a"]).toBe(earlier);
    expect(toolsets()["wiki:session-b"]).not.toBe(earlier);
  });

  /**
   * An orient starting immediately used to get a toolset that was still being
   * gathered: some subagents of the same run received the wiki tools and
   * others only coding tools, and the ones without reported wiki_capture_source
   * missing. session_start awaits the gathering, and pi awaits session_start.
   */
  it("has the wiki tools ready by the time session_start resolves", async () => {
    const session = makeSessionPi("session-a");
    wikiIngestBridge(session.pi);

    await session.start();

    const names = toolsets()["wiki:session-a"]!().map(
      (tool) => (tool as { name: string }).name,
    );
    expect(names).toContain("wiki_capture_source");
  });

  // A run started before session_start, or a process running one session, still
  // resolves the bare tag.
  it("keeps the unsuffixed tag available", () => {
    const only = makeSessionPi("session-a");
    wikiIngestBridge(only.pi);

    expect(typeof toolsets().wiki).toBe("function");
  });
});
