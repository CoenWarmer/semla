/**
 * Two things need checking: that the env var this module sets is the one
 * pi-mcp-adapter actually reads to collapse its config-source chain, and that
 * it does not override an operator's own choice.
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PI_AGENT_DIR_ENV } from "./agent-dir.ts";
import {
  isolateMcpConfigMode,
  MCP_CONFIG_MODE_ENV,
  MCP_CONFIG_PATH,
  MCP_EXCLUSIVE_CONFIG_MODE,
} from "./mcp-config.ts";

const originalMode = process.env[MCP_CONFIG_MODE_ENV];
const originalAgentDir = process.env[PI_AGENT_DIR_ENV];

afterEach(() => {
  if (originalMode === undefined) delete process.env[MCP_CONFIG_MODE_ENV];
  else process.env[MCP_CONFIG_MODE_ENV] = originalMode;
  if (originalAgentDir === undefined) delete process.env[PI_AGENT_DIR_ENV];
  else process.env[PI_AGENT_DIR_ENV] = originalAgentDir;
});

describe("isolateMcpConfigMode", () => {
  it("defaults to exclusive", () => {
    delete process.env[MCP_CONFIG_MODE_ENV];

    const result = isolateMcpConfigMode();

    expect(result.mode).toBe(MCP_EXCLUSIVE_CONFIG_MODE);
    expect(process.env[MCP_CONFIG_MODE_ENV]).toBe(MCP_EXCLUSIVE_CONFIG_MODE);
  });

  it("leaves an operator's own setting alone", () => {
    process.env[MCP_CONFIG_MODE_ENV] = "merge";

    const result = isolateMcpConfigMode();

    expect(result.mode).toBe("merge");
    expect(process.env[MCP_CONFIG_MODE_ENV]).toBe("merge");
  });

  it("an explicit option still wins over the environment", () => {
    process.env[MCP_CONFIG_MODE_ENV] = "merge";

    const result = isolateMcpConfigMode({ mode: MCP_EXCLUSIVE_CONFIG_MODE });

    expect(result.mode).toBe(MCP_EXCLUSIVE_CONFIG_MODE);
  });

  it("reports the config path under the current agent dir", () => {
    // MCP_CONFIG_PATH is computed once at import time from PI_AGENT_DIR, not
    // from the mutable PI_CODING_AGENT_DIR env var — this asserts the two
    // stay in the same directory rather than drifting apart.
    const result = isolateMcpConfigMode();

    expect(result.path).toBe(MCP_CONFIG_PATH);
    expect(result.path.endsWith(join("mcp.json"))).toBe(true);
  });
});

/**
 * Confirms this module's understanding of the package's own precedence
 * collapse against the package source directly, via jiti — the same way
 * mcp-package-contract.test.ts loads it, and for the same reason: the claim
 * lives in a docblock and would otherwise go untested against a release that
 * changes it.
 */
describe("pi-mcp-adapter exclusive mode", () => {
  const packageConfigPath = join(
    process.cwd(),
    "node_modules/pi-mcp-adapter/config.ts",
  );
  const installed = existsSync(packageConfigPath);

  it.skipIf(!installed)(
    "collapses config discovery to exactly the path this module computes",
    async () => {
      const { createJiti } = await import("jiti");
      const jiti = createJiti(import.meta.url, { interopDefault: true });
      const { getConfigDiscoveryPaths } = (await jiti.import(packageConfigPath, {})) as {
        getConfigDiscoveryPaths: (
          overridePath: string | undefined,
          cwd: string,
        ) => { path: string }[];
      };

      const previousMode = process.env[MCP_CONFIG_MODE_ENV];
      const previousAgentDir = process.env[PI_AGENT_DIR_ENV];
      try {
        const agentDir = mkdtempSync(join(tmpdir(), "semla-mcp-config-"));
        process.env[PI_AGENT_DIR_ENV] = agentDir;
        process.env[MCP_CONFIG_MODE_ENV] = MCP_EXCLUSIVE_CONFIG_MODE;

        // MCP_CONFIG_PATH is fixed at this module's first import, from whatever
        // PI_AGENT_DIR held then — it cannot pick up the temp dir set just above.
        // Re-import fresh (vitest resets the module registry) so the value
        // compared against the package's own answer is computed under the same
        // environment the package sees, not the one this file loaded under.
        vi.resetModules();
        const { MCP_CONFIG_PATH: pathUnderTempDir } = await import("./mcp-config.ts");

        const sources = getConfigDiscoveryPaths(undefined, process.cwd());

        expect(sources).toHaveLength(1);
        expect(sources[0]?.path).toBe(join(agentDir, "mcp.json"));
        expect(sources[0]?.path).toBe(pathUnderTempDir);
      } finally {
        if (previousMode === undefined) delete process.env[MCP_CONFIG_MODE_ENV];
        else process.env[MCP_CONFIG_MODE_ENV] = previousMode;
        if (previousAgentDir === undefined) delete process.env[PI_AGENT_DIR_ENV];
        else process.env[PI_AGENT_DIR_ENV] = previousAgentDir;
      }
    },
  );
});
