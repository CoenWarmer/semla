import { existsSync, statSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PI_TOOLS, WIKI_EXTENSION_PATH } from "./runtime-config.ts";

describe("PI_TOOLS", () => {
  it("contains the expected built-in tools", () => {
    expect(PI_TOOLS).toContain("read");
    expect(PI_TOOLS).toContain("bash");
    expect(PI_TOOLS).toContain("workflow");
    expect(PI_TOOLS).toContain("ask_user");
  });
});

describe("WIKI_EXTENSION_PATH", () => {
  // The @zosmaai/pi-llm-wiki package declares pi.extensions = ["./extensions"]
  // which resolves to a directory with no index.ts at its root. Pi's loader
  // cannot import a directory, so the extension silently fails to load and the
  // agent never sees wiki tools. WIKI_EXTENSION_PATH bypasses the broken
  // package declaration by pointing directly at the real entry file.
  it("points to an existing file (not a directory)", () => {
    expect(
      existsSync(WIKI_EXTENSION_PATH),
      `Wiki extension not found at ${WIKI_EXTENSION_PATH}. ` +
        "Run `pi packages sync` or `npm install` inside .pi/npm to install it.",
    ).toBe(true);

    const stat = statSync(WIKI_EXTENSION_PATH);
    expect(stat.isDirectory()).toBe(false);
    expect(stat.isFile()).toBe(true);
  });

  it("ends with .ts or .js so jiti can load it", () => {
    expect(WIKI_EXTENSION_PATH).toMatch(/\.(ts|js)$/);
  });

  it("is anchored to process.cwd(), not PI_WORKSPACE_ROOT", async () => {
    // PI_WORKSPACE_ROOT is the user's project directory — e.g. /Users/coen/Dev.
    // The wiki package lives under Semla's own .pi/npm/, so the path must be
    // rooted at the server's cwd, not the workspace the agent is operating in.
    // This test re-imports the module with a spoofed PI_WORKSPACE_ROOT to catch
    // any regression where the constant switches back to using that env var.
    const serverRoot = process.cwd();
    const savedRoot = process.env.PI_WORKSPACE_ROOT;
    process.env.PI_WORKSPACE_ROOT = "/tmp/fake-workspace";
    vi.resetModules();

    try {
      const { WIKI_EXTENSION_PATH: pathWithFakeRoot } = await import(
        "./runtime-config.ts"
      );
      expect(pathWithFakeRoot).toContain(serverRoot);
      expect(pathWithFakeRoot).not.toContain("/tmp/fake-workspace");
    } finally {
      if (savedRoot === undefined) {
        delete process.env.PI_WORKSPACE_ROOT;
      } else {
        process.env.PI_WORKSPACE_ROOT = savedRoot;
      }
      vi.resetModules();
    }
  });
});

/**
 * The extension loader caches compiled factories process-wide, and nothing in
 * Semla ever invalidates them — so before this flag existed, editing one of
 * Semla's own pi extensions did nothing until the dev server was restarted.
 * Turbopack cannot cover it: jiti loads those files outside Next's module graph.
 */
describe("REFRESH_EXTENSIONS_PER_SESSION", () => {
  const load = async (nodeEnv: string) => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", nodeEnv);
    const mod = await import("./runtime-config.ts");
    return mod.REFRESH_EXTENSIONS_PER_SESSION;
  };

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("is on in development, so an extension edit is picked up", async () => {
    expect(await load("development")).toBe(true);
  });

  // The second reload costs a full extension compile on every prompt, and the
  // files cannot change under a running production process anyway.
  it("is off in production", async () => {
    expect(await load("production")).toBe(false);
  });
});
