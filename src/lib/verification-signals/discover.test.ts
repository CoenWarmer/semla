/**
 * Discovery, per category, against a real temp tree.
 *
 * The MCP summary is mocked rather than the agent directory redirected:
 * mcp-config.ts computes MCP_CONFIG_PATH from PI_AGENT_DIR at import time, so
 * a test that set the env var would depend on module load order. The mock
 * still returns a real `configPath`, which is what lets the out-of-repo drift
 * case below be exercised for real — that is the drift a per-project commit
 * sha provably cannot see, so a mock that faked the path away would test
 * nothing.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { McpConfigSummary } from "@/lib/pi/runtime/mcp-config";

let mcpSummary: McpConfigSummary;
vi.mock("@/lib/pi/runtime/mcp-config", () => ({
  getMcpConfigSummary: () => Promise.resolve(mcpSummary),
}));

const { discoverVerificationSignals } = await import("./discover");

let root: string;
let agentDir: string;

function noMcp(configPath: string): McpConfigSummary {
  return { configPath, enabledServers: [], error: null, hint: null, servers: [] };
}

function writePackage(manifest: unknown): void {
  writeFileSync(join(root, "package.json"), JSON.stringify(manifest), "utf8");
}

function signal(signals: Awaited<ReturnType<typeof discoverVerificationSignals>>["signals"], category: string) {
  return signals.find((entry) => entry.category === category);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "verification-signals-"));
  agentDir = mkdtempSync(join(tmpdir(), "verification-agent-"));
  mcpSummary = noMcp(join(agentDir, "mcp.json"));
});

afterEach(() => {
  rmSync(root, { force: true, recursive: true });
  rmSync(agentDir, { force: true, recursive: true });
});

describe("script-derived signals", () => {
  it("reports unit tests available with the script as evidence", async () => {
    writePackage({ scripts: { test: "vitest run" } });

    const { signals } = await discoverVerificationSignals({ root });

    expect(signal(signals, "unit-test")).toEqual({
      category: "unit-test",
      evidence: 'package.json scripts.test = "vitest run"',
      state: "available",
    });
  });

  it("accepts either script name for typecheck", async () => {
    // This repository's script is `tsc` and it has no `typecheck`; the plan's
    // first draft checked only the name this repo does not have.
    writePackage({ scripts: { tsc: "npx tsc" } });
    const viaTsc = await discoverVerificationSignals({ root });
    expect(signal(viaTsc.signals, "typecheck")?.state).toBe("available");
    expect(signal(viaTsc.signals, "typecheck")?.evidence).toContain("scripts.tsc");

    writePackage({ scripts: { typecheck: "tsc --noEmit" } });
    const viaTypecheck = await discoverVerificationSignals({ root });
    expect(signal(viaTypecheck.signals, "typecheck")?.state).toBe("available");
    expect(signal(viaTypecheck.signals, "typecheck")?.evidence).toContain("scripts.typecheck");
  });

  it("never calls a dev server available, however plainly its script exists", async () => {
    writePackage({ scripts: { dev: "next dev" } });

    const { signals } = await discoverVerificationSignals({ root });

    expect(signal(signals, "dev-server")?.state).toBe("configured-not-verified");
  });

  it("emits integration-test only off a distinct script", async () => {
    writePackage({ scripts: { test: "vitest run" } });
    const collapsed = await discoverVerificationSignals({ root });
    expect(signal(collapsed.signals, "integration-test")).toBeUndefined();

    writePackage({ scripts: { test: "vitest run", "test:integration": "vitest run int" } });
    const distinct = await discoverVerificationSignals({ root });
    expect(signal(distinct.signals, "integration-test")?.state).toBe("available");
  });
});

describe("config-derived signals", () => {
  it("reports a config with no script behind it as configured-not-verified", async () => {
    writePackage({ scripts: {} });
    writeFileSync(join(root, ".oxlintrc.json"), "{}", "utf8");

    const { signals } = await discoverVerificationSignals({ root });

    expect(signal(signals, "lint")).toEqual({
      category: "lint",
      detail: ".oxlintrc.json",
      evidence: ".oxlintrc.json exists, but no lint script runs it",
      state: "configured-not-verified",
    });
  });
});

describe("e2e signals", () => {
  it("is possible-not-configured when only the dependency is present", async () => {
    writePackage({ dependencies: { playwright: "^1.50.0" }, scripts: {} });

    const { signals } = await discoverVerificationSignals({ root });

    expect(signal(signals, "e2e-test")).toEqual({
      category: "e2e-test",
      detail: "playwright",
      evidence:
        "package.json declares playwright@^1.50.0, but no config file and no test:e2e script wire it up",
      state: "possible-not-configured",
    });
  });

  it("emits nothing at all when neither dependency nor config exists", async () => {
    // An absent category is not a finding. "You could add an e2e suite" is
    // advice, and this module does not give advice.
    writePackage({ scripts: { test: "vitest run" } });

    const { signals } = await discoverVerificationSignals({ root });

    expect(signal(signals, "e2e-test")).toBeUndefined();
  });

  it("is available when a script exists, with the config as detail", async () => {
    writePackage({ devDependencies: { playwright: "^1.50.0" }, scripts: { "test:e2e": "playwright test" } });
    writeFileSync(join(root, "playwright.config.ts"), "export default {};", "utf8");

    const { signals } = await discoverVerificationSignals({ root });

    expect(signal(signals, "e2e-test")).toMatchObject({
      detail: "playwright.config.ts",
      state: "available",
    });
  });
});

describe("MCP signals", () => {
  it("reports one configured-not-verified entry per enabled server", async () => {
    writePackage({ scripts: {} });
    const configPath = join(agentDir, "mcp.json");
    writeFileSync(configPath, JSON.stringify({ mcpServers: { "brave-devtools": {} } }), "utf8");
    mcpSummary = {
      configPath,
      enabledServers: ["brave-devtools"],
      error: null,
      hint: null,
      servers: ["brave-devtools", "disabled-one"],
    };

    const { signals } = await discoverVerificationSignals({ root });
    const mcp = signals.filter((entry) => entry.category === "mcp");

    expect(mcp).toHaveLength(1);
    expect(mcp[0]).toMatchObject({ detail: "brave-devtools", state: "configured-not-verified" });
  });

  it("produces no mcp signals and no error when there is no config file", async () => {
    writePackage({ scripts: {} });

    const { signals, warnings } = await discoverVerificationSignals({ root });

    expect(signals.some((entry) => entry.category === "mcp")).toBe(false);
    expect(warnings).toEqual([]);
  });

  it("surfaces a config read error as a warning rather than throwing", async () => {
    writePackage({ scripts: {} });
    mcpSummary = { ...noMcp(join(agentDir, "mcp.json")), error: "bad json" };

    const { warnings } = await discoverVerificationSignals({ root });

    expect(warnings.some((warning) => warning.includes("bad json"))).toBe(true);
  });
});

describe("inputs digest", () => {
  it("moves when package.json changes", async () => {
    writePackage({ scripts: { test: "vitest run" } });
    const before = await discoverVerificationSignals({ root });

    writePackage({ scripts: { test: "vitest run", lint: "oxlint" } });
    const after = await discoverVerificationSignals({ root });

    expect(after.inputsDigest).not.toBe(before.inputsDigest);
  });

  it("moves when the out-of-repo mcp.json changes", async () => {
    // The whole reason phase 3 has a digest instead of a commit sha: this file
    // is per-machine and outside every project.
    writePackage({ scripts: {} });
    const configPath = join(agentDir, "mcp.json");
    writeFileSync(configPath, JSON.stringify({ mcpServers: {} }), "utf8");
    mcpSummary = noMcp(configPath);
    const before = await discoverVerificationSignals({ root });

    writeFileSync(configPath, JSON.stringify({ mcpServers: { added: {} } }), "utf8");
    const after = await discoverVerificationSignals({ root });

    expect(after.inputsDigest).not.toBe(before.inputsDigest);
  });

  it("does not move when an unrelated source file changes", async () => {
    writePackage({ scripts: { test: "vitest run" } });
    const before = await discoverVerificationSignals({ root });

    writeFileSync(join(root, "index.ts"), "export const x = 1;", "utf8");
    const after = await discoverVerificationSignals({ root });

    expect(after.inputsDigest).toBe(before.inputsDigest);
  });
});

describe("degraded inputs", () => {
  it("warns rather than throwing on an unparseable package.json", async () => {
    writeFileSync(join(root, "package.json"), "{ not json", "utf8");

    const { signals, warnings } = await discoverVerificationSignals({ root });

    expect(signals.some((entry) => entry.category === "unit-test")).toBe(false);
    expect(warnings.some((warning) => warning.includes("could not be parsed"))).toBe(true);
  });

  it("warns when there is no package.json at all", async () => {
    const { warnings } = await discoverVerificationSignals({ root });

    expect(warnings.some((warning) => warning.includes("No package.json"))).toBe(true);
  });
});
