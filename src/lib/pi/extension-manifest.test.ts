/**
 * The manifest turns three previously-implicit things into checked ones: load
 * order, what each extension owes, and what the UI advertises. These tests
 * cover the checks themselves; extension-load.smoke.test.ts proves the manifest
 * matches the real Pi runtime.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  ACTIVE_WORKFLOW_MANAGER,
  clearSlot,
  CONTRACT_SLOT_KEYS,
  WIKI_INGEST_DISPATCHER,
  WIKI_REINDEX_DISPATCHER,
  writeSlot,
} from "./extension-contract.ts";
import {
  assertExtensionLoad,
  assertExtensionPathsExist,
  assertManifestIsCoherent,
  buildExtensionLoadReport,
  describeExtensionProblems,
  EXTENSION_MANIFEST,
  EXTENSION_TOOLS,
  extensionPathsInLoadOrder,
  resolveExtensionLoadOrder,
  type ExtensionSpec,
} from "./extension-manifest.ts";
import { PI_TOOLS } from "./runtime-config.ts";

const spec = (over: Partial<ExtensionSpec> & Pick<ExtensionSpec, "id">) =>
  ({
    path: `/tmp/${over.id}.ts`,
    requires: [],
    providesTools: [],
    optionalTools: [],
    providesSlots: [],
    remedy: "",
    ...over,
  }) as ExtensionSpec;

const indexOf = (order: ExtensionSpec[], id: string) =>
  order.findIndex((s) => s.id === id);

describe("load order", () => {
  it("puts the wiki bridge after both extensions it depends on", () => {
    // This was previously only a comment on WIKI_INGEST_BRIDGE_PATH. The bridge
    // reads the workflow manager slot and replaces a pi-llm-wiki code path, so
    // loading it first leaves both hooks unarmed.
    const order = resolveExtensionLoadOrder();
    expect(indexOf(order, "wiki-ingest-bridge")).toBeGreaterThan(
      indexOf(order, "workflow"),
    );
    expect(indexOf(order, "wiki-ingest-bridge")).toBeGreaterThan(
      indexOf(order, "wiki"),
    );
  });

  it("holds even when the manifest is declared in the wrong order", () => {
    const shuffled = [...EXTENSION_MANIFEST].reverse();
    const order = resolveExtensionLoadOrder(shuffled);
    expect(indexOf(order, "wiki-ingest-bridge")).toBeGreaterThan(
      indexOf(order, "workflow"),
    );
    expect(indexOf(order, "wiki-ingest-bridge")).toBeGreaterThan(
      indexOf(order, "wiki"),
    );
  });

  it("includes every extension exactly once", () => {
    const order = resolveExtensionLoadOrder();
    expect(order).toHaveLength(EXTENSION_MANIFEST.length);
    expect(new Set(order.map((s) => s.id)).size).toBe(EXTENSION_MANIFEST.length);
  });

  it("emits paths in the resolved order", () => {
    expect(extensionPathsInLoadOrder()).toEqual(
      resolveExtensionLoadOrder().map((s) => s.path),
    );
  });

  it("rejects a dependency cycle", () => {
    const cyclic = [
      spec({ id: "workflow" as const, requires: ["wiki" as const] }),
      spec({ id: "wiki" as const, requires: ["workflow" as const] }),
    ];
    expect(() => resolveExtensionLoadOrder(cyclic)).toThrow(/Cyclic/);
  });

  it("rejects a dependency that is not in the manifest", () => {
    const dangling = [
      spec({ id: "wiki-ingest-bridge" as const, requires: ["workflow" as const] }),
    ];
    expect(() => resolveExtensionLoadOrder(dangling)).toThrow(/unknown extension/);
  });
});

describe("manifest coherence", () => {
  it("accepts the real manifest", () => {
    expect(() => assertManifestIsCoherent()).not.toThrow();
  });

  it("rejects two extensions claiming the same tool", () => {
    const clashing = [
      spec({ id: "wiki" as const, providesTools: ["wiki_recall"] }),
      spec({ id: "wiki-ingest-bridge" as const, providesTools: ["wiki_recall"] }),
    ];
    expect(() => assertManifestIsCoherent(clashing)).toThrow(/claimed by both/);
  });

  it("rejects an extension shadowing a built-in tool name", () => {
    const shadowing = [spec({ id: "wiki" as const, providesTools: ["bash"] })];
    expect(() => assertManifestIsCoherent(shadowing)).toThrow(/built-in/);
  });
});

describe("EXTENSION_TOOLS", () => {
  it("is derived from the manifest rather than hand-maintained", () => {
    expect(EXTENSION_TOOLS).toEqual(
      EXTENSION_MANIFEST.flatMap((s) => [...s.providesTools]),
    );
  });

  it("still advertises the wiki tools the UI expects", () => {
    expect(EXTENSION_TOOLS).toContain("wiki_recall");
    expect(EXTENSION_TOOLS).toContain("wiki_capture_source");
    expect(EXTENSION_TOOLS).toContain("wiki_bootstrap");
  });

  it("excludes gated tools, which are not always registered", () => {
    // pi-llm-wiki only registers these when llm-wiki.trajectories is enabled.
    // Advertising them unconditionally is what the old hand-maintained list did.
    const gated = EXTENSION_MANIFEST.flatMap((s) => [...s.optionalTools]);
    expect(gated).toContain("wiki_capture_trajectory");
    for (const tool of gated) expect(EXTENSION_TOOLS).not.toContain(tool);
  });

  it("does not duplicate a toggleable built-in", () => {
    // The workflow/ask-user tools are built-in names backed by extensions; the
    // UI lists them under toggleableTools, so they must not also appear here.
    const builtins = new Set<string>(PI_TOOLS as readonly string[]);
    const advertised = EXTENSION_MANIFEST.filter(
      (s) => s.id !== "workflow" && s.id !== "ask-user",
    ).flatMap((s) => [...s.providesTools]);
    for (const tool of advertised) expect(builtins.has(tool)).toBe(false);
  });
});

describe("path validation", () => {
  it("accepts the real manifest, so every entry file is installed", () => {
    expect(() => assertExtensionPathsExist()).not.toThrow();
  });

  it("rejects a directory, with the remedy attached", () => {
    // The exact shape of the pi-llm-wiki bug: pi.extensions pointed at a
    // directory and Pi produced no wiki tools without reporting anything.
    const asDirectory = [
      spec({
        id: "wiki" as const,
        path: process.cwd(),
        remedy: "Run `npm install --prefix .pi/npm`.",
      }),
    ];
    expect(() => assertExtensionPathsExist(asDirectory)).toThrow(
      /not an importable module file|is a directory/,
    );
  });

  it("rejects a missing file, with the remedy attached", () => {
    const missing = [
      spec({
        id: "wiki" as const,
        path: "/tmp/definitely-not-installed.ts",
        remedy: "Run `npm install --prefix .pi/npm`.",
      }),
    ];
    expect(() => assertExtensionPathsExist(missing)).toThrow(
      /missing at [\s\S]*Run `npm install --prefix \.pi\/npm`\./,
    );
  });
});

describe("load report", () => {
  const specs = [
    spec({
      id: "workflow" as const,
      path: "/tmp/workflow.ts",
      providesTools: ["workflow", "workflow_control"],
      providesSlots: [ACTIVE_WORKFLOW_MANAGER],
    }),
    spec({
      id: "wiki-ingest-bridge" as const,
      path: "/tmp/bridge.ts",
      requires: ["workflow" as const],
      providesSlots: [WIKI_INGEST_DISPATCHER, WIKI_REINDEX_DISPATCHER],
    }),
  ];

  const armSlots = () => {
    writeSlot(ACTIVE_WORKFLOW_MANAGER, { startInBackground: () => ({ runId: "r" }) });
    writeSlot(WIKI_INGEST_DISPATCHER, () => true);
    writeSlot(WIKI_REINDEX_DISPATCHER, () => true);
  };

  afterEach(() => {
    for (const key of CONTRACT_SLOT_KEYS) clearSlot(key);
  });

  it("passes when everything loaded and contributed", () => {
    armSlots();
    const report = buildExtensionLoadReport({
      loadedPaths: ["/tmp/workflow.ts", "/tmp/bridge.ts"],
      loadErrors: [],
      registeredTools: ["workflow", "workflow_control", "read"],
      specs,
    });
    expect(report.ok).toBe(true);
    expect(() => assertExtensionLoad(report, specs)).not.toThrow();
  });

  it("fails when an extension loaded but registered no tools", () => {
    armSlots();
    const report = buildExtensionLoadReport({
      loadedPaths: ["/tmp/workflow.ts", "/tmp/bridge.ts"],
      loadErrors: [],
      registeredTools: ["read"],
      specs,
    });
    expect(report.ok).toBe(false);
    expect(report.extensions[0].missingTools).toEqual([
      "workflow",
      "workflow_control",
    ]);
    expect(() => assertExtensionLoad(report, specs)).toThrow(
      /did not register workflow, workflow_control/,
    );
  });

  it("fails when an extension loaded but published no contract slot", () => {
    // The bridge registers no tools at all, so a slot check is the only thing
    // that can tell whether it actually armed its dispatchers.
    writeSlot(ACTIVE_WORKFLOW_MANAGER, { startInBackground: () => ({ runId: "r" }) });
    const report = buildExtensionLoadReport({
      loadedPaths: ["/tmp/workflow.ts", "/tmp/bridge.ts"],
      loadErrors: [],
      registeredTools: ["workflow", "workflow_control"],
      specs,
    });
    expect(report.ok).toBe(false);
    expect(report.extensions[1].missingSlots).toEqual([
      "semla.wiki-ingest-dispatcher",
      "semla.wiki-reindex-dispatcher",
    ]);
  });

  it("fails when an extension did not load at all, and says why", () => {
    armSlots();
    const report = buildExtensionLoadReport({
      loadedPaths: ["/tmp/workflow.ts"],
      loadErrors: [{ path: "/tmp/bridge.ts", error: "boom" }],
      registeredTools: ["workflow", "workflow_control"],
      specs,
    });
    expect(report.ok).toBe(false);
    expect(describeExtensionProblems(report, specs).join("\n")).toMatch(
      /wiki-ingest-bridge: did not load \(boom\)/,
    );
  });

  it("flags the same entry file loaded twice", () => {
    // The shared-agent-dir regression: one extension loaded from two places,
    // the second copy failing with a tool-name conflict.
    armSlots();
    const report = buildExtensionLoadReport({
      loadedPaths: ["/tmp/workflow.ts", "/tmp/workflow.ts", "/tmp/bridge.ts"],
      loadErrors: [],
      registeredTools: ["workflow", "workflow_control"],
      specs,
    });
    expect(report.ok).toBe(false);
    expect(report.duplicatePaths).toEqual(["/tmp/workflow.ts"]);
    expect(describeExtensionProblems(report, specs).join("\n")).toMatch(
      /loaded more than once/,
    );
  });

  it("reports errors from non-manifest extensions without failing the session", () => {
    // A project-scope package from the workspace's own .pi/settings.json can
    // fail for reasons this manifest knows nothing about. Surfaced for the
    // health endpoint and the logs, but not a reason to refuse a session.
    armSlots();
    const report = buildExtensionLoadReport({
      loadedPaths: ["/tmp/workflow.ts", "/tmp/bridge.ts"],
      loadErrors: [{ path: "/tmp/stray.ts", error: "nope" }],
      registeredTools: ["workflow", "workflow_control"],
      specs,
    });
    expect(report.ok).toBe(true);
    expect(report.unexpectedErrors).toEqual(["/tmp/stray.ts: nope"]);
  });
});
