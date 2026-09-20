/**
 * The one-time relocation of `~/.pi/workflows` to the `~/.semla` home.
 *
 * Every case passes both directories explicitly rather than leaning on
 * `homedir()`. `vitest.setup.ts` sets PI_WORKFLOW_HOME per test file, so
 * `workflowHomeDir()` never reaches the migration here — and a test that did
 * reach the real one would be operating on the operator's own run history,
 * which is precisely the accident the override was introduced to stop.
 *
 * `resetWorkflowHomeMigrationForTests()` is needed because the guard is a
 * module-level boolean: without it the second case in this file would assert
 * against `reason: "already-attempted"` from the first.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LEGACY_WORKFLOW_HOME_RELATIVE_DIR,
  WORKFLOW_HOME_RELATIVE_DIR,
} from "./config.ts";
import {
  migrateLegacyWorkflowHome,
  resetWorkflowHomeMigrationForTests,
} from "./workflow-paths.ts";

let root: string;

beforeEach(() => {
  resetWorkflowHomeMigrationForTests();
  root = mkdtempSync(join(tmpdir(), "semla-wf-migrate-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  resetWorkflowHomeMigrationForTests();
});

/** A populated legacy home, with one file deep enough to prove a real move. */
function legacyHomeWith(contents: string): { legacy: string; target: string } {
  const legacy = join(root, LEGACY_WORKFLOW_HOME_RELATIVE_DIR);
  mkdirSync(join(legacy, "projects", "demo-abc123"), { recursive: true });
  writeFileSync(join(legacy, "settings.json"), contents, "utf-8");
  writeFileSync(join(legacy, "projects", "demo-abc123", "runs.json"), "[]", "utf-8");
  return { legacy, target: join(root, WORKFLOW_HOME_RELATIVE_DIR) };
}

describe("migrateLegacyWorkflowHome", () => {
  it("moves the legacy home, contents and all, to the semla home", () => {
    const { legacy, target } = legacyHomeWith('{"jevGateEnabled":true}');

    const result = migrateLegacyWorkflowHome(target, legacy);

    expect(result.migrated).toBe(true);
    expect(existsSync(legacy)).toBe(false);
    expect(readFileSync(join(target, "settings.json"), "utf-8")).toBe(
      '{"jevGateEnabled":true}',
    );
    // Nested project state has to survive, or run history is lost silently.
    expect(existsSync(join(target, "projects", "demo-abc123", "runs.json"))).toBe(true);
  });

  it("creates the parent of the target, which need not exist yet", () => {
    // ~/.semla exists on a machine that has run Semla, but not on a fresh one.
    const { legacy, target } = legacyHomeWith("{}");
    expect(existsSync(join(root, ".semla"))).toBe(false);

    expect(migrateLegacyWorkflowHome(target, legacy).migrated).toBe(true);
    expect(existsSync(target)).toBe(true);
  });

  it("leaves both alone when the semla home already exists", () => {
    // Never merge: two `projects/` trees keyed the same way would resurrect
    // runs the retention cap already collected, with no way to rank a clash.
    const { legacy, target } = legacyHomeWith('{"from":"legacy"}');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "settings.json"), '{"from":"semla"}', "utf-8");

    const result = migrateLegacyWorkflowHome(target, legacy);

    expect(result).toMatchObject({ migrated: false, reason: "target-exists" });
    expect(readFileSync(join(target, "settings.json"), "utf-8")).toBe('{"from":"semla"}');
    expect(existsSync(legacy)).toBe(true);
  });

  it("is a no-op when there is no legacy home", () => {
    const target = join(root, WORKFLOW_HOME_RELATIVE_DIR);

    const result = migrateLegacyWorkflowHome(target, join(root, ".pi", "workflows"));

    expect(result).toMatchObject({ migrated: false, reason: "no-legacy-dir" });
    // Resolution must not create the home as a side effect of not migrating.
    expect(existsSync(target)).toBe(false);
  });

  it("runs at most once per process", () => {
    const { legacy, target } = legacyHomeWith("{}");
    expect(migrateLegacyWorkflowHome(target, legacy).migrated).toBe(true);

    // A second legacy home appearing later is not the operator's old state,
    // and re-checking on every path resolution would stat the filesystem on a
    // hot path for a condition that can only be true once.
    mkdirSync(legacy, { recursive: true });
    expect(migrateLegacyWorkflowHome(target, legacy)).toMatchObject({
      migrated: false,
      reason: "already-attempted",
    });
  });
});

describe("workflow home constants", () => {
  it("roots user-level state under .semla, never the pi CLI's directory", () => {
    // The rule in AGENTS.md: ~/.pi belongs to the pi CLI, shared with anything
    // else on the machine that invokes it, so Semla may not keep state there.
    expect(WORKFLOW_HOME_RELATIVE_DIR.startsWith(".semla/")).toBe(true);
    expect(WORKFLOW_HOME_RELATIVE_DIR).not.toContain(".pi/");
  });
});
