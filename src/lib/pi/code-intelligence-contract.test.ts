/**
 * Build-time signal for the code intelligence package, and for the decision
 * about where extension dependencies are allowed to be declared.
 *
 * This package used to be declared in `.pi/npm/package.json` and loaded through
 * pi's own package resolution. That tree is invisible to `npm audit` at the
 * repository root, and what hid there was a wildcard peer dependency pulling a
 * second, older copy of the pi agent runtime with three advisories against it —
 * including one about `auth.json` writes exposing credentials. Nothing in the
 * repository would have told anyone.
 *
 * So two things are asserted here that tsc cannot see:
 *
 *  - the version is pinned exactly, because this is loaded by a path into
 *    node_modules and a floating range lets a release move the file;
 *  - it is *not* declared in `.pi/npm` or `.pi/settings.json`, so the decision
 *    recorded in AGENTS.md fails a build rather than eroding quietly.
 *
 * The tool set is checked against the package itself, so a release that renames
 * or drops one breaks here rather than in a session that silently has no code
 * navigation.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EXTENSION_MANIFEST } from "./extension-manifest.ts";
import { CODE_INTELLIGENCE_EXTENSION_PATH } from "./runtime-config.ts";

const PACKAGE = "@mrclrchtr/supi-code-intelligence";

const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

const rootPackageJson = readJson(join(process.cwd(), "package.json"));
const declared = (rootPackageJson.dependencies as Record<string, string>)[PACKAGE];

const installed = existsSync(CODE_INTELLIGENCE_EXTENSION_PATH);

describe(`${PACKAGE} declaration`, () => {
  it("is a dependency of this repository, not of .pi/npm", () => {
    expect(
      declared,
      `${PACKAGE} must be declared in the root package.json — see the ` +
        "extension-dependency decision in AGENTS.md",
    ).toBeDefined();
  });

  it("is pinned to an exact version", () => {
    // Loaded by a path into node_modules, so a range means a release can move
    // or rename the entry file with no commit here.
    expect(declared).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("is no longer declared in .pi/npm", () => {
    const piNpm = readJson(join(process.cwd(), ".pi/npm/package.json"));
    const deps = (piNpm.dependencies ?? {}) as Record<string, string>;

    expect(Object.keys(deps)).not.toContain(PACKAGE);
  });

  it("is no longer loaded through pi's package resolution", () => {
    const settings = readJson(join(process.cwd(), ".pi/settings.json"));
    const packages = (settings.packages ?? []) as string[];

    expect(packages.filter((entry) => entry.includes("supi"))).toEqual([]);
  });
});

describe(`${PACKAGE} tool set`, () => {
  const spec = EXTENSION_MANIFEST.find((entry) => entry.id === "code-intelligence");

  it("is declared in the extension manifest", () => {
    // Without this the load verification does not cover it, which is how a
    // package that failed to load became a session with no tools and only a
    // console warning.
    expect(spec).toBeDefined();
    // Loaded by path on purpose: the package publishes TypeScript source, so
    // Pi's loader has to compile it. See ExtensionSource.
    expect(spec?.source).toEqual({
      kind: "path",
      path: CODE_INTELLIGENCE_EXTENSION_PATH,
    });
  });

  it.skipIf(!installed)(
    "matches the headless profile the package exports",
    async () => {
      const { createJiti } = await import("jiti");
      const jiti = createJiti(import.meta.url, { interopDefault: true });
      const profile = (await jiti.import(CODE_INTELLIGENCE_EXTENSION_PATH, {})) as {
        HEADLESS_INSPECTION_TOOL_NAMES?: readonly string[];
      };

      expect([...(profile.HEADLESS_INSPECTION_TOOL_NAMES ?? [])].sort()).toEqual(
        [...(spec?.providesTools ?? [])].sort(),
      );
    },
  );

  it.skipIf(!installed)("registers exactly those tools when loaded", async () => {
    const { createJiti } = await import("jiti");
    const jiti = createJiti(import.meta.url, { interopDefault: true });
    const factory = (await jiti.import(CODE_INTELLIGENCE_EXTENSION_PATH, {
      default: true,
    })) as (api: unknown) => void;

    const registered: string[] = [];
    factory({
      on: () => {},
      registerTool: (tool: { name: string }) => registered.push(tool.name),
    });

    expect(registered.sort()).toEqual([...(spec?.providesTools ?? [])].sort());
  });
});
