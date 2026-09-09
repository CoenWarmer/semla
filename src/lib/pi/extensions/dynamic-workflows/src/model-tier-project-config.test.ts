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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  getModelTierConfigPath,
  getProjectModelTierConfigPath,
  loadModelTierConfig,
} from "./model-tier-config.ts";
import { workflowHomeDir, workflowProjectsDir } from "./workflow-paths.ts";

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

/**
 * Write the user-level config.
 *
 * These assertions used to be written around this file instead of controlling
 * it — "whatever the home file says (possibly nothing)" — because it was the
 * operator's real one. Several of them therefore compared
 * `loadModelTierConfig({ cwd })` against `loadModelTierConfig()` and held
 * whichever way both went, including when both returned null. The home path
 * resolves under PI_WORKFLOW_HOME now, so the fallback can be given a value
 * and named.
 */
function homeWith(tiers: Record<string, string>): void {
  const path = getModelTierConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ tiers }), "utf-8");
}

// The temp home is per test file, so it is shared by everything below.
afterEach(() => {
  rmSync(getModelTierConfigPath(), { force: true });
});

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
    homeWith({ small: "openrouter/home-loses" });
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
    homeWith({ small: "openrouter/from-home" });
    const cwd = mkdtempSync(join(tmpdir(), "semla-tiers-empty-"));

    expect(loadModelTierConfig({ cwd })?.tiers.small).toBe("openrouter/from-home");
  });

  it("ignores a corrupt project file instead of failing the run", () => {
    homeWith({ small: "openrouter/from-home" });
    const cwd = projectWith("{ not json");

    expect(loadModelTierConfig({ cwd })?.tiers.small).toBe("openrouter/from-home");
  });

  it("ignores a degenerate project file", () => {
    // Same isValidTiersMap rule the writer enforces: an empty map or a tier
    // mapped to "" would resolve to undefined at use time, so it must fall
    // through to home rather than load as a truthy-but-broken config.
    homeWith({ small: "openrouter/from-home" });
    const cwd = projectWith({ small: "" });

    expect(loadModelTierConfig({ cwd })?.tiers.small).toBe("openrouter/from-home");
  });

  it("returns null when neither file exists", () => {
    // The both-absent case the three tests above used to collapse into, when
    // the home file they compared against happened not to exist either.
    const cwd = mkdtempSync(join(tmpdir(), "semla-tiers-none-"));

    expect(loadModelTierConfig({ cwd })).toBeNull();
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

/**
 * The user-level path must stay derived from `workflowHomeDir()`.
 *
 * This is the assertion whose absence let the suite write the operator's real
 * tier config: `getModelTierConfigPath()` spelled out `homedir()`, so the
 * PI_WORKFLOW_HOME redirection every other piece of workflow state honours
 * stopped at this one file. Nothing failed — it simply kept resolving to the
 * live config, which route.test.ts then overwrote and restored by hand.
 */
describe("user-level model tiers", () => {
  it("resolves under the workflow home override", () => {
    const home = mkdtempSync(join(tmpdir(), "semla-tiers-home-"));
    const previous = process.env.PI_WORKFLOW_HOME;
    process.env.PI_WORKFLOW_HOME = home;

    try {
      expect(getModelTierConfigPath()).toBe(join(home, "model-tiers.json"));
    } finally {
      process.env.PI_WORKFLOW_HOME = previous;
    }
  });

  it("is read on each call, so a redirect does not need to precede import", () => {
    // Captured at import instead, the override would have to win a race with
    // module load order that a test cannot control.
    const first = mkdtempSync(join(tmpdir(), "semla-tiers-home-a-"));
    const second = mkdtempSync(join(tmpdir(), "semla-tiers-home-b-"));
    const previous = process.env.PI_WORKFLOW_HOME;

    try {
      process.env.PI_WORKFLOW_HOME = first;
      const before = getModelTierConfigPath();
      process.env.PI_WORKFLOW_HOME = second;

      expect(getModelTierConfigPath()).not.toBe(before);
    } finally {
      process.env.PI_WORKFLOW_HOME = previous;
    }
  });

  it("is a sibling of the per-project tree, not a child of one", () => {
    // The tier config is machine-level. Keying it by cwd would silently
    // un-share it, and would also make it subject to the retention sweep that
    // prunes project directories.
    expect(getModelTierConfigPath()).toBe(
      join(workflowHomeDir(), "model-tiers.json"),
    );
    expect(getModelTierConfigPath()).not.toContain(
      join(workflowProjectsDir(), ""),
    );
  });

  it("is isolated by vitest.setup.ts, so no test can reach the real one", () => {
    // The guard on the leak itself rather than on the derivation: if the
    // per-file redirect ever stops being installed, every assertion above
    // starts running against the operator's own configuration again.
    expect(process.env.PI_WORKFLOW_HOME).toBeTruthy();
    expect(getModelTierConfigPath()).not.toBe(
      join(homedir(), ".pi", "workflows", "model-tiers.json"),
    );
  });
});
