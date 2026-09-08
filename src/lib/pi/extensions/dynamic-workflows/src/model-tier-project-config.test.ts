/**
 * A repository can ship its own workflow model tiers.
 *
 * Tiers name concrete `provider/model` specs, so a home-only config encodes
 * one machine's provider credentials and is shared with every other pi install
 * on it. This repository is authenticated to openrouter; a tier file naming
 * `anthropic/...` makes every tiered subagent fail with "No API key found",
 * which is exactly how the research agentType broke.
 *
 * These tests pin the precedence and the back-compatible call shapes, because
 * a regression in either is silent: the wrong file simply loads and subagents
 * route somewhere unintended.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  getModelTierConfigPath,
  getProjectModelTierConfigPath,
  loadModelTierConfig,
} from "./model-tier-config.ts";

/** A project directory holding `.pi/workflows/model-tiers.json`. */
function projectWith(tiers: Record<string, string> | string): string {
  const root = mkdtempSync(join(tmpdir(), "semla-tiers-"));
  const dir = join(root, ".pi", "workflows");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "model-tiers.json"),
    typeof tiers === "string" ? tiers : JSON.stringify({ tiers }),
    "utf-8",
  );
  return root;
}

describe("project-local model tiers", () => {
  it("puts the file under .pi/workflows, next to the other project state", () => {
    expect(getProjectModelTierConfigPath("/repo")).toBe(
      "/repo/.pi/workflows/model-tiers.json",
    );
  });

  it("is a different location from the user-level file", () => {
    // If these ever collide, "project wins" becomes meaningless.
    expect(getProjectModelTierConfigPath("/repo")).not.toBe(
      getModelTierConfigPath(),
    );
  });

  it("loads the project file when a cwd is given", () => {
    const cwd = projectWith({ small: "openrouter/cheap", big: "openrouter/dear" });

    expect(loadModelTierConfig({ cwd })?.tiers.small).toBe("openrouter/cheap");
  });

  it("prefers the project file over the user-level one", () => {
    // The home file is whatever this machine happens to have; the assertion
    // that matters is that it is not consulted when a project file exists.
    const cwd = projectWith({ small: "openrouter/project-wins" });

    expect(loadModelTierConfig({ cwd })?.tiers.small).toBe(
      "openrouter/project-wins",
    );
  });

  it("replaces the whole tier set rather than merging tier by tier", () => {
    // A merge could leave `small` from the project above a cheaper `medium`
    // from home, inverting the ordering with nothing to detect it.
    const cwd = projectWith({ small: "openrouter/only-small" });
    const config = loadModelTierConfig({ cwd });

    expect(Object.keys(config?.tiers ?? {})).toEqual(["small"]);
  });

  it("falls back to the user-level file when the project has none", () => {
    const cwd = mkdtempSync(join(tmpdir(), "semla-tiers-empty-"));

    // Whatever the home file says (possibly nothing) — the point is that an
    // absent project file is not an error and does not shadow it.
    expect(loadModelTierConfig({ cwd })).toEqual(loadModelTierConfig());
  });

  it("ignores a corrupt project file instead of failing the run", () => {
    const cwd = projectWith("{ not json");

    expect(loadModelTierConfig({ cwd })).toEqual(loadModelTierConfig());
  });

  it("ignores a degenerate project file", () => {
    // Same isValidTiersMap rule the writer enforces: an empty map or a tier
    // mapped to "" would resolve to undefined at use time.
    const cwd = projectWith({ small: "" });

    expect(loadModelTierConfig({ cwd })).toEqual(loadModelTierConfig());
  });

  it("still accepts an explicit path as a positional string", () => {
    // The original signature. Tests and the /workflows-models command both
    // pass a bare path, and an options-only signature would break them.
    const cwd = projectWith({ small: "openrouter/project" });
    const explicit = join(cwd, ".pi", "workflows", "model-tiers.json");

    expect(loadModelTierConfig(explicit)?.tiers.small).toBe("openrouter/project");
  });

  it("does not read a project file when given an explicit path", () => {
    const cwd = projectWith({ small: "openrouter/project" });
    const elsewhere = projectWith({ small: "openrouter/elsewhere" });
    const explicit = join(elsewhere, ".pi", "workflows", "model-tiers.json");

    expect(loadModelTierConfig({ configPath: explicit, cwd })?.tiers.small).toBe(
      "openrouter/elsewhere",
    );
  });
});
