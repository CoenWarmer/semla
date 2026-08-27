import { existsSync, statSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { EXTENSION_TOOLS, PI_TOOLS, WIKI_EXTENSION_PATH } from "./runtime-config.ts";

describe("PI_TOOLS", () => {
  it("contains the expected built-in tools", () => {
    expect(PI_TOOLS).toContain("read");
    expect(PI_TOOLS).toContain("bash");
    expect(PI_TOOLS).toContain("workflow");
    expect(PI_TOOLS).toContain("ask_user");
  });
});

describe("EXTENSION_TOOLS", () => {
  it("contains the expected wiki tools", () => {
    expect(EXTENSION_TOOLS).toContain("wiki_recall");
    expect(EXTENSION_TOOLS).toContain("wiki_capture_source");
    expect(EXTENSION_TOOLS).toContain("wiki_bootstrap");
  });

  it("has no overlap with PI_TOOLS", () => {
    const piSet = new Set(PI_TOOLS as readonly string[]);
    for (const tool of EXTENSION_TOOLS) {
      expect(piSet.has(tool)).toBe(false);
    }
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
});
