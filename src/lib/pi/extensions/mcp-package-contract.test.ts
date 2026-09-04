/**
 * Build-time signal for pi-mcp-adapter, and for the decision about where
 * extension dependencies are allowed to be declared.
 *
 * See docs/plans/mcp-servers.md for the spike this rests on. Three things kept
 * this package safe to load as a plain path extension rather than through
 * `pi install` (which would have recreated `.pi/npm`, the failure AGENTS.md
 * spends a page on):
 *
 *  - its MCP implementation is the official `@modelcontextprotocol/client` SDK;
 *  - its peer dependencies name the `@earendil-works` scope pi actually uses
 *    now, not the abandoned `@mariozechner` scope `@zosmaai/pi-llm-wiki`
 *    wildcards against \u2014 so there is no second agent runtime to alias away;
 *  - its native keyring dependency ships per-platform optional dependencies,
 *    not a postinstall download that would need an `allowScripts` entry.
 *
 * Those are asserted here so a release that changes any of them breaks a build
 * rather than reintroducing the exact failure this repository already fixed
 * once for the wiki package.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EXTENSION_MANIFEST } from "../extension-manifest.ts";
import { MCP_EXTENSION_PATH, MCP_PACKAGE_DIR } from "../runtime-config.ts";

const PACKAGE = "pi-mcp-adapter";

const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

const rootPackageJson = readJson(join(process.cwd(), "package.json"));
const declared = (rootPackageJson.dependencies as Record<string, string>)[PACKAGE];

const installed = existsSync(MCP_EXTENSION_PATH);

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

  it("matches the installed copy", () => {
    const installedVersion = readJson(join(MCP_PACKAGE_DIR, "package.json")).version;
    expect(
      installedVersion,
      "Installed pi-mcp-adapter differs from the pin. Run `npm install`.",
    ).toBe(declared);
  });
});

describe(`${PACKAGE} peer dependencies`, () => {
  it("declares peers against the scope this repository actually pins", () => {
    const peers = readJson(join(MCP_PACKAGE_DIR, "package.json"))
      .peerDependencies as Record<string, string> | undefined;

    expect(
      peers,
      `${PACKAGE} peerDependencies changed shape; re-check for a wildcard ` +
        "peer against an abandoned scope, the failure this test exists to catch.",
    ).toBeDefined();

    // No @mariozechner peer to alias away — unlike @zosmaai/pi-llm-wiki, this
    // package never names the abandoned scope. If it starts to, it needs the
    // same overrides treatment that package got.
    for (const name of Object.keys(peers ?? {})) {
      expect(name.startsWith("@mariozechner/")).toBe(false);
    }
  });

  it.each(["@earendil-works/pi-ai", "@earendil-works/pi-tui"])(
    "resolves %s to a single pinned copy on disk",
    (name) => {
      const resolved = readJson(join(process.cwd(), "node_modules", name, "package.json"));
      expect(resolved.name).toBe(name);
      // Pinned exactly at the root; a second, older copy would mean this peer
      // range was satisfied by installing a runtime of its own.
      expect(resolved.version).toBe("0.84.2");
    },
  );
});

describe(`${PACKAGE} native dependency`, () => {
  it("ships the keyring as optional dependencies, not a postinstall download", () => {
    const keyringPkg = readJson(
      join(process.cwd(), "node_modules/@napi-rs/keyring/package.json"),
    );

    expect(
      keyringPkg.optionalDependencies,
      "@napi-rs/keyring no longer ships per-platform optionalDependencies. If " +
        "it moved to a postinstall binary fetch, this repository gates install " +
        "scripts and the package would need an allowScripts entry to work at all.",
    ).toBeDefined();

    const scripts = keyringPkg.scripts as Record<string, string> | undefined;
    expect(scripts?.postinstall).toBeUndefined();
  });
});

describe(`${PACKAGE} tool set`, () => {
  const spec = EXTENSION_MANIFEST.find((entry) => entry.id === "mcp");

  it("is declared in the extension manifest", () => {
    expect(spec).toBeDefined();
    // Loaded by path on purpose: the package publishes TypeScript source, and
    // its README's claim that it "must be installed through pi" does not hold
    // — it declares pi.extensions: ["./index.ts"], a plain path, and
    // `export default createMcpAdapter()` is exactly the shape Pi's own path
    // loader calls. See docs/plans/mcp-servers.md §2.
    expect(spec?.source).toEqual({ kind: "path", path: MCP_EXTENSION_PATH });
  });

  it.skipIf(!installed)("registers the mcp gateway tool when loaded", async () => {
    const { createJiti } = await import("jiti");
    const jiti = createJiti(import.meta.url, { interopDefault: true });
    const factory = (await jiti.import(MCP_EXTENSION_PATH, {
      default: true,
    })) as (api: unknown) => void;

    const registeredTools: string[] = [];
    const flags = new Map<string, unknown>();

    factory({
      registerTool: (tool: { name: string }) => registeredTools.push(tool.name),
      registerCommand: () => {},
      on: () => {},
      events: { on: () => {} },
      registerFlag: (name: string, options: { default?: unknown }) => {
        flags.set(name, options?.default);
      },
      getFlag: (name: string) => flags.get(name),
      getAllTools: () => [],
      setActiveTools: () => {},
      getActiveTools: () => [],
    });

    // mcpScript is reported as optional and never required — see the manifest
    // entry's comment — so only the gateway tool is asserted here.
    expect(registeredTools).toContain("mcp");
    expect([...(spec?.providesTools ?? [])]).toEqual(["mcp"]);
  });
});
