/**
 * Compensating check for the one deep import mcp-config.ts makes into
 * pi-mcp-adapter's compiled output, in the mould of
 * WIKI_PACKAGE_DEEP_IMPORTS in wiki-ingest-bridge.ts: a release that renames
 * or moves `loadMcpConfig` would otherwise break getMcpConfigSummary() with
 * nothing failing at build time.
 */
import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { MCP_CONFIG_DEEP_IMPORT, getMcpConfigSummary } from "./mcp-config.ts";

describe("pi-mcp-adapter dist/config.js deep import", () => {
  it("still exists and exports what mcp-config.ts calls", () => {
    expect(
      existsSync(MCP_CONFIG_DEEP_IMPORT.path),
      `${MCP_CONFIG_DEEP_IMPORT.path} is gone. mcp-config.ts imports it at ` +
        "runtime; update the path or pin back.",
    ).toBe(true);

    const source = readFileSync(MCP_CONFIG_DEEP_IMPORT.path, "utf8");
    for (const name of MCP_CONFIG_DEEP_IMPORT.exports) {
      // Matches `export function x`, `export async function x`, `export const x`,
      // `exports.x = ...` (CJS), and `export { x }` / `export { y as x }`.
      const declaration = new RegExp(
        String.raw`export\s+(async\s+)?(function|const|let|class)\s+${name}\b`,
      );
      const reExport = new RegExp(String.raw`export\s*\{[^}]*\b${name}\b[^}]*\}`);
      const cjsAssignment = new RegExp(String.raw`exports\.${name}\s*=`);

      expect(
        declaration.test(source) || reExport.test(source) || cjsAssignment.test(source),
        `${MCP_CONFIG_DEEP_IMPORT.path} no longer exports "${name}", which ` +
          "mcp-config.ts calls at runtime.",
      ).toBe(true);
    }
  });

  it("getMcpConfigSummary reads the compiled module without throwing", async () => {
    const summary = await getMcpConfigSummary();

    // No mcp.json exists in this test environment, so an empty server list —
    // not an error — is the correct, honest answer.
    expect(summary.error).toBeNull();
    expect(Array.isArray(summary.servers)).toBe(true);
    expect(Array.isArray(summary.enabledServers)).toBe(true);
    expect(typeof summary.configPath).toBe("string");
  });
});
