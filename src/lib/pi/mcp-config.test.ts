/**
 * Two things need checking: that the env var this module sets is the one
 * pi-mcp-adapter actually reads to collapse its config-source chain, and that
 * it does not override an operator's own choice.
 */
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
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
    const result = isolateMcpConfigMode();

    expect(result.path).toBe(MCP_CONFIG_PATH);
    expect(result.path.endsWith(join("mcp.json"))).toBe(true);
  });
});

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

describe("getMcpConfigSummary misplaced-server detection", () => {
  const previousMode = process.env[MCP_CONFIG_MODE_ENV];
  const previousAgentDir = process.env[PI_AGENT_DIR_ENV];

  afterEach(() => {
    if (previousMode === undefined) delete process.env[MCP_CONFIG_MODE_ENV];
    else process.env[MCP_CONFIG_MODE_ENV] = previousMode;
    if (previousAgentDir === undefined) delete process.env[PI_AGENT_DIR_ENV];
    else process.env[PI_AGENT_DIR_ENV] = previousAgentDir;
  });

  const withConfig = async (contents: string) => {
    const agentDir = mkdtempSync(join(tmpdir(), "semla-mcp-hint-"));
    writeFileSync(join(agentDir, "mcp.json"), contents, "utf8");
    process.env[PI_AGENT_DIR_ENV] = agentDir;
    process.env[MCP_CONFIG_MODE_ENV] = MCP_EXCLUSIVE_CONFIG_MODE;
    vi.resetModules();
    const mod = await import("./mcp-config.ts");
    return mod.getMcpConfigSummary();
  };

  it("hints when a command-based server is written at the top level", async () => {
    const summary = await withConfig(
      JSON.stringify({
        "brave-devtools": { type: "stdio", command: "npx", args: ["-y", "brave-mcp@latest"] },
      }),
    );

    expect(summary.error).toBeNull();
    expect(summary.servers).toEqual([]);
    expect(summary.hint).toContain("brave-devtools");
    expect(summary.hint).toContain("mcpServers");
  });

  it("hints when a url-based server is written at the top level", async () => {
    const summary = await withConfig(
      JSON.stringify({ deepwiki: { url: "https://mcp.deepwiki.com/mcp" } }),
    );

    expect(summary.hint).toContain("deepwiki");
  });

  it("does not hint for a deliberately empty config", async () => {
    const summary = await withConfig(JSON.stringify({}));

    expect(summary.hint).toBeNull();
  });

  it("does not hint once servers are correctly nested under mcpServers", async () => {
    const summary = await withConfig(
      JSON.stringify({
        mcpServers: { deepwiki: { url: "https://mcp.deepwiki.com/mcp" } },
      }),
    );

    expect(summary.hint).toBeNull();
    expect(summary.servers).toEqual(["deepwiki"]);
  });

  it("does not hint when the file does not exist at all", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "semla-mcp-hint-"));
    process.env[PI_AGENT_DIR_ENV] = agentDir;
    process.env[MCP_CONFIG_MODE_ENV] = MCP_EXCLUSIVE_CONFIG_MODE;
    vi.resetModules();
    const mod = await import("./mcp-config.ts");

    const summary = await mod.getMcpConfigSummary();

    expect(summary.hint).toBeNull();
    expect(summary.error).toBeNull();
  });

  it("reports unparseable JSON as `error`, not `hint`", async () => {
    const summary = await withConfig("{ not json");

    expect(summary.error).not.toBeNull();
    expect(summary.hint).toBeNull();
  });
});
