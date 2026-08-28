/**
 * Boots a real Pi session against a throwaway workspace and checks that the
 * extension set the manifest declares is the extension set that actually
 * materialises.
 *
 * Everything else in this directory is a unit test, and unit tests cannot reach
 * the failures that have actually bitten this integration, because those live
 * in the runtime seam rather than in our logic:
 *
 *  - extensions are compiled and imported by jiti, which resolves module
 *    specifiers differently from tsc and from Next.js (no "@/" alias), so an
 *    import that type-checks can still fail to load;
 *  - tools only register during bindExtensions(), and contract slots are only
 *    published from the session_start handlers that same call fires — the bug
 *    where Semla never called bindExtensions() left workflow results queued
 *    forever and was invisible to every unit test;
 *  - the declared wiki tool list is a claim about a third-party package.
 *
 * Skips when no Pi model is configured on the host: creating a session needs
 * one, and a machine without credentials should not fail the suite.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ExtensionLoadReport, ExtensionSpec } from "./extension-manifest.ts";

const BOOT_TIMEOUT_MS = 180_000;

type Loaded = {
  report: ExtensionLoadReport;
  specs: readonly ExtensionSpec[];
  boundTools: string[];
  loadedPaths: string[];
  slotArmed: (name: string) => boolean;
  assertLoad: (report: ExtensionLoadReport) => void;
};

let loaded: Loaded | null = null;
let skipReason: string | null = null;
let cleanup: (() => Promise<void>) | null = null;

beforeAll(async () => {
  // Temp roots for everything Pi writes, and WIKI_HOME set before the modules
  // that read it are imported — hence dynamic imports throughout this block.
  const root = await mkdtemp(join(tmpdir(), "semla-ext-smoke-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  process.env.WIKI_HOME = join(root, "wiki");

  const { mkdir } = await import("node:fs/promises");
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(agentDir, { recursive: true }),
    mkdir(sessionDir, { recursive: true }),
  ]);

  const {
    createAgentSession,
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
  } = await import("@earendil-works/pi-coding-agent");
  const {
    assertExtensionLoad,
    assertExtensionPathsExist,
    assertManifestIsCoherent,
    buildExtensionLoadReport,
    EXTENSION_MANIFEST,
    extensionPathsInLoadOrder,
  } = await import("./extension-manifest.ts");
  const contract = await import("./extension-contract.ts");
  const { WORKFLOW_SKILLS_PATH } = await import("./runtime-config.ts");

  const runtime = await ModelRuntime.create({ refreshOnCreate: false });
  const available = await runtime.getAvailable().catch(() => []);
  const model = available[0];

  if (!model) {
    skipReason =
      "no Pi model is configured on this host (creating a session requires one)";
    cleanup = () => rm(root, { force: true, recursive: true });
    return;
  }

  // Same pre-flight the server runs before handing paths to Pi.
  assertManifestIsCoherent();
  assertExtensionPathsExist();

  const sessionFile = join(sessionDir, "smoke.jsonl");
  await writeFile(
    sessionFile,
    JSON.stringify({
      cwd: workspace,
      id: "smoke",
      timestamp: new Date().toISOString(),
      type: "session",
      version: 3,
    }) + "\n",
    "utf8",
  );

  const resourceLoader = new DefaultResourceLoader({
    additionalExtensionPaths: extensionPathsInLoadOrder(),
    additionalSkillPaths: [WORKFLOW_SKILLS_PATH],
    agentDir,
    cwd: workspace,
    appendSystemPrompt: ["smoke test"],
  });
  await resourceLoader.reload();

  const { extensionsResult, session } = await createAgentSession({
    cwd: workspace,
    model,
    modelRuntime: runtime,
    resourceLoader,
    sessionManager: SessionManager.open(sessionFile, sessionDir, workspace),
  });

  await session.bindExtensions({ mode: "print", onError: () => {} });

  const loadedPaths = extensionsResult.extensions.map((e) => e.path);
  const boundTools = session.getActiveToolNames();

  loaded = {
    report: buildExtensionLoadReport({
      loadedPaths,
      loadErrors: extensionsResult.errors,
      registeredTools: boundTools,
    }),
    specs: EXTENSION_MANIFEST,
    boundTools,
    loadedPaths,
    slotArmed: (name) =>
      contract.readSlot(
        Symbol.for(name) as (typeof contract.CONTRACT_SLOT_KEYS)[number],
      ) !== undefined,
    assertLoad: (report) => assertExtensionLoad(report),
  };

  cleanup = async () => {
    session.dispose();
    for (const key of contract.CONTRACT_SLOT_KEYS) contract.clearSlot(key);
    await rm(root, { force: true, recursive: true });
  };
}, BOOT_TIMEOUT_MS);

afterAll(async () => {
  await cleanup?.();
});

describe("Pi extension load (real session)", () => {
  const check = (name: string, assertion: (l: Loaded) => void) =>
    it(name, (ctx) => {
      if (!loaded) return ctx.skip(`Skipped: ${skipReason}`);
      assertion(loaded);
    });

  check("loads every extension in the manifest", (l) => {
    for (const spec of l.specs) {
      expect(
        l.loadedPaths,
        `${spec.id} did not load. ${spec.remedy}`,
      ).toContain(spec.path);
    }
  });

  check("registers every tool the manifest declares", (l) => {
    // Catches both a wiki release that drops a tool and a manifest that claims
    // a tool the extension never actually provided.
    for (const spec of l.specs) {
      for (const tool of spec.providesTools) {
        expect(l.boundTools, `${spec.id} did not register "${tool}"`).toContain(
          tool,
        );
      }
    }
  });

  check("publishes every contract slot the manifest declares", (l) => {
    for (const spec of l.specs) {
      for (const slot of spec.providesSlots) {
        expect(
          l.slotArmed(slot.description!),
          `${spec.id} did not publish ${slot.description}`,
        ).toBe(true);
      }
    }
  });

  check("arms the wiki dispatchers across the jiti module boundary", (l) => {
    // The bridge reaches the contract through a relative specifier because jiti
    // cannot resolve Next.js's "@/" alias. If that import ever stops resolving,
    // the extension loads, registers nothing, and wiki_ingest quietly falls
    // back to inline synthesis — exactly the silent failure this catches.
    expect(l.slotArmed("semla.wiki-ingest-dispatcher")).toBe(true);
    expect(l.slotArmed("semla.wiki-reindex-dispatcher")).toBe(true);
  });

  check("loads no extension file twice", (l) => {
    expect(l.report.duplicatePaths).toEqual([]);
  });

  check("produces a clean report the server would accept", (l) => {
    expect(l.report.ok, JSON.stringify(l.report, null, 2)).toBe(true);
    expect(() => l.assertLoad(l.report)).not.toThrow();
  });
});
