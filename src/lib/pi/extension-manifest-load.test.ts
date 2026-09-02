/**
 * Loads the real manifest through Pi's real resource loader, and checks that
 * what the manifest promises is what materialises.
 *
 * extension-load.smoke.test.ts already does this — and more, since contract
 * slots are only published from the session_start that bindExtensions() fires.
 * But it needs a configured model to create a session, so it skips on most
 * machines, which is exactly where a broken manifest would go unnoticed.
 *
 * The resource loader needs no model. So the half that can always run, always
 * runs: every declared extension loads, and every tool it promises registers.
 * That catches a third-party release dropping a tool, a factory that throws on
 * import, and a manifest that claims something it does not deliver.
 *
 * Isolated into temp directories because loading the wiki extension touches a
 * vault, and WIKI_HOME is read when the module is first imported.
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import type { ResourceLoader } from "@earendil-works/pi-coding-agent";

/** Derived from the loader rather than naming an internal Pi type. */
type LoadedExtensions = ReturnType<ResourceLoader["getExtensions"]>;

type Manifest = typeof import("./extension-manifest.ts");

let result: LoadedExtensions;
let manifest: Manifest;

beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), "semla-manifest-load-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  process.env.WIKI_HOME = join(root, "wiki");

  const { DefaultResourceLoader } = await import("@earendil-works/pi-coding-agent");
  manifest = await import("./extension-manifest.ts");

  const loader = new DefaultResourceLoader({
    // Both lists, exactly as session-service passes them.
    additionalExtensionPaths: manifest.extensionPathsInLoadOrder(),
    agentDir,
    cwd: workspace,
    extensionFactories: manifest.extensionFactoriesInLoadOrder(),
    noContextFiles: true,
    noPromptTemplates: true,
    noSkills: true,
    noThemes: true,
  });

  await loader.reload();
  result = loader.getExtensions();
}, 120_000);

describe("the manifest against Pi's loader", () => {
  it("loads with no errors", () => {
    expect(
      result.errors.map((error) => `${error.path}: ${String(error.error)}`),
    ).toEqual([]);
  });

  it("loads every extension the manifest declares", () => {
    const loaded = new Set(result.extensions.map((extension) => extension.path));

    for (const spec of manifest.EXTENSION_MANIFEST) {
      expect(
        loaded.has(manifest.extensionEntryId(spec)),
        `${spec.id} did not load. ${spec.remedy}`,
      ).toBe(true);
    }
  });

  it("registers every tool the manifest promises", () => {
    const registered = new Set(
      result.extensions.flatMap((extension) => [...extension.tools.keys()]),
    );

    for (const spec of manifest.EXTENSION_MANIFEST) {
      for (const tool of spec.providesTools) {
        expect(
          registered.has(tool),
          `${spec.id} promised "${tool}" but did not register it. ${spec.remedy}`,
        ).toBe(true);
      }
    }
  });

  it("labels an imported factory the way extensionEntryId expects", () => {
    // The load report matches specs to loaded extensions by this string, so a
    // change in Pi's labelling would silently report everything as unloaded.
    const inline = result.extensions
      .map((extension) => extension.path)
      .filter((path) => path.startsWith("<inline:"));

    expect(inline).toContain("<inline:workflow>");
    expect(inline).toHaveLength(
      manifest.extensionFactoriesInLoadOrder().length,
    );
  });

  it("loads paths before factories, which the manifest relies on", () => {
    // wiki-ingest-bridge is a factory that requires the path-loaded wiki
    // extension. assertManifestIsCoherent enforces the rule; this proves Pi
    // still behaves that way.
    const paths = result.extensions.map((extension) => extension.path);
    const lastPath = paths.findLastIndex((path) => !path.startsWith("<inline:"));
    const firstInline = paths.findIndex((path) => path.startsWith("<inline:"));

    expect(firstInline).toBeGreaterThan(lastPath);
  });
});
