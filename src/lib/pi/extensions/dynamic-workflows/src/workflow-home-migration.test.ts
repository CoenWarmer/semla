/**
 * Where workflow state is rooted, and the one-time relocation of the two
 * home-directory layouts that preceded it.
 *
 * Every migration case passes both sides explicitly rather than leaning on
 * `homedir()` or `process.cwd()`. `vitest.setup.ts` sets PI_WORKFLOW_HOME per
 * test file, so `workflowHomeDir()` never reaches the migration here — and a
 * test that did reach the real one would be operating on the operator's own
 * run history, which is precisely the accident the override exists to stop.
 *
 * `resetWorkflowHomeMigrationForTests()` is needed because the guard is a
 * module-level boolean: without it the second case would assert against
 * `reason: "already-attempted"` left by the first.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LEGACY_WORKFLOW_HOME_RELATIVE_DIRS,
  WORKFLOW_PROJECT_RELATIVE_DIR,
  WORKFLOW_STATE_SUBDIR,
} from "./config.ts";
import {
  migrateLegacyWorkflowHome,
  resetWorkflowHomeMigrationForTests,
  semlaStateDir,
  workflowHomeDir,
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

const target = () => join(root, ".semla-state", WORKFLOW_STATE_SUBDIR);

/** A populated legacy home, with nested state to prove a real move. */
function legacyHomeWith(relative: string, marker: string): string {
  const legacy = join(root, relative);
  mkdirSync(join(legacy, "projects", "demo-abc123"), { recursive: true });
  writeFileSync(join(legacy, "settings.json"), marker, "utf-8");
  writeFileSync(join(legacy, "projects", "demo-abc123", "runs.json"), "[]", "utf-8");
  return legacy;
}

describe("migrateLegacyWorkflowHome", () => {
  it("moves a legacy home, contents and all, into the state directory", () => {
    const legacy = legacyHomeWith(".pi/workflows", '{"jevGateEnabled":true}');

    const result = migrateLegacyWorkflowHome(target(), [legacy]);

    expect(result).toMatchObject({ migrated: true, from: legacy });
    expect(existsSync(legacy)).toBe(false);
    expect(readFileSync(join(target(), "settings.json"), "utf-8")).toBe(
      '{"jevGateEnabled":true}',
    );
    // Nested project state has to survive, or run history is lost silently.
    expect(existsSync(join(target(), "projects", "demo-abc123", "runs.json"))).toBe(true);
  });

  it("prefers the newer legacy home when an operator has both", () => {
    // Someone who ran the ~/.semla/workflows build has state in it that the
    // older ~/.pi copy predates; taking the older one would silently roll back.
    const newer = legacyHomeWith(".semla/workflows", '{"from":"semla"}');
    legacyHomeWith(".pi/workflows", '{"from":"pi"}');

    const result = migrateLegacyWorkflowHome(target(), [
      newer,
      join(root, ".pi/workflows"),
    ]);

    expect(result).toMatchObject({ migrated: true, from: newer });
    expect(readFileSync(join(target(), "settings.json"), "utf-8")).toBe('{"from":"semla"}');
  });

  it("creates the parent of the target, which need not exist yet", () => {
    // .semla-state/ exists in a checkout Semla has run in, but not a fresh one.
    const legacy = legacyHomeWith(".pi/workflows", "{}");
    expect(existsSync(join(root, ".semla-state"))).toBe(false);

    expect(migrateLegacyWorkflowHome(target(), [legacy]).migrated).toBe(true);
    expect(existsSync(target())).toBe(true);
  });

  it("leaves both alone when the target already exists", () => {
    // Never merge: two `projects/` trees keyed the same way would resurrect
    // runs the retention cap already collected, with no way to rank a clash.
    const legacy = legacyHomeWith(".pi/workflows", '{"from":"legacy"}');
    mkdirSync(target(), { recursive: true });
    writeFileSync(join(target(), "settings.json"), '{"from":"state"}', "utf-8");

    const result = migrateLegacyWorkflowHome(target(), [legacy]);

    expect(result).toMatchObject({ migrated: false, reason: "target-exists" });
    expect(readFileSync(join(target(), "settings.json"), "utf-8")).toBe('{"from":"state"}');
    expect(existsSync(legacy)).toBe(true);
  });

  it("is a no-op when there is no legacy home", () => {
    const result = migrateLegacyWorkflowHome(target(), [join(root, ".pi/workflows")]);

    expect(result).toMatchObject({ migrated: false, reason: "no-legacy-dir" });
    // Resolution must not create the home as a side effect of not migrating.
    expect(existsSync(target())).toBe(false);
  });

  it("runs at most once per process", () => {
    const legacy = legacyHomeWith(".pi/workflows", "{}");
    expect(migrateLegacyWorkflowHome(target(), [legacy]).migrated).toBe(true);

    // A legacy home appearing later is not the operator's old state, and
    // re-checking on every path resolution would stat the filesystem on a hot
    // path for a condition that can only be true once.
    mkdirSync(legacy, { recursive: true });
    expect(migrateLegacyWorkflowHome(target(), [legacy])).toMatchObject({
      migrated: false,
      reason: "already-attempted",
    });
  });
});

describe("workflow state root", () => {
  it("agrees with SEMLA_STATE_DIR, which it cannot import", () => {
    // stores/user-settings-store.ts is the definition; this tree has no "@/"
    // alias because backfill-stuck-workflow-agents.mjs loads it under plain
    // node. So the two lines are duplicated, and this is what keeps them equal.
    const previous = process.env.SEMLA_STATE_DIR;
    try {
      process.env.SEMLA_STATE_DIR = join(root, "elsewhere");
      expect(semlaStateDir()).toBe(join(root, "elsewhere"));
    } finally {
      if (previous === undefined) delete process.env.SEMLA_STATE_DIR;
      else process.env.SEMLA_STATE_DIR = previous;
    }
  });

  it("falls back to .semla-state in the server's cwd, not a session's", () => {
    // Nothing calls process.chdir, and sessions are handed a cwd instead (see
    // session-cwd.ts). If this resolved per-session, every repository Semla
    // touched would grow its own workflow state directory.
    const previous = process.env.SEMLA_STATE_DIR;
    try {
      delete process.env.SEMLA_STATE_DIR;
      expect(semlaStateDir()).toBe(join(process.cwd(), ".semla-state"));
    } finally {
      if (previous !== undefined) process.env.SEMLA_STATE_DIR = previous;
    }
  });

  it("puts the home under the state directory, not a home directory", () => {
    const previous = process.env.PI_WORKFLOW_HOME;
    try {
      process.env.PI_WORKFLOW_HOME = "";
      process.env.SEMLA_STATE_DIR = join(root, ".semla-state");
      expect(workflowHomeDir()).toBe(target());
    } finally {
      delete process.env.SEMLA_STATE_DIR;
      if (previous === undefined) delete process.env.PI_WORKFLOW_HOME;
      else process.env.PI_WORKFLOW_HOME = previous;
    }
  });

  it("keeps PI_WORKFLOW_HOME winning outright", () => {
    // The whole test suite depends on this: vitest.setup.ts points it at a
    // temp dir so no test can reach the operator's real state.
    expect(process.env.PI_WORKFLOW_HOME).toBeTruthy();
    expect(workflowHomeDir()).toBe(process.env.PI_WORKFLOW_HOME);
  });
});

describe("committed project config", () => {
  it("stays out of the gitignored state directory", () => {
    // The tier file is meant to be committed and reviewed, so unlike every
    // other path here it must not land under .semla-state/.
    expect(WORKFLOW_PROJECT_RELATIVE_DIR).not.toContain(".semla-state");
  });

  it("is resolved against a cwd, which is what separates it from the legacy home", () => {
    // `.semla/workflows` is string-identical to the newer legacy home, and
    // that is not a bug: this one is joined onto a project cwd and that one
    // onto homedir(), so they only coincide if a checkout IS the home
    // directory. Named here because the shared spelling looks like a clash.
    expect(LEGACY_WORKFLOW_HOME_RELATIVE_DIRS).toContain(
      WORKFLOW_PROJECT_RELATIVE_DIR,
    );
    expect(join("/repo", WORKFLOW_PROJECT_RELATIVE_DIR)).not.toBe(
      join(root, WORKFLOW_PROJECT_RELATIVE_DIR),
    );
  });
});
