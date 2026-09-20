/**
 * Filesystem layout for pi-dynamic-workflows state.
 *
 * New writes live under the user's workflow home so projects do not get
 * scattered per-project workflow directories. Project-scoped state is still isolated
 * by a stable cwd-derived namespace.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  LEGACY_WORKFLOW_HOME_RELATIVE_DIRS,
  WORKFLOW_RUNS_DIR,
  WORKFLOW_SAVED_DIR,
  WORKFLOW_STATE_SUBDIR,
} from "./config.ts";

export const WORKFLOW_PROJECTS_SUBDIR = "projects";

export interface WorkflowProjectPaths {
  key: string;
  rootDir: string;
  runsDir: string;
  savedDir: string;
  settingsPath: string;
  legacyRunsDir: string;
  legacySavedDir: string;
}

/**
 * Semla's own state directory, re-derived rather than imported.
 *
 * `SEMLA_STATE_DIR` in `stores/user-settings-store.ts` is the definition, and
 * this repeats its two lines. It cannot be imported: nothing in this extension
 * tree uses the `"@/"` alias, because the tree is also loaded outside Next —
 * `scripts/backfill-stuck-workflow-agents.mjs` imports this very module under
 * plain node, where the alias does not resolve. Reading the same env var with
 * the same fallback is what keeps the two agreeing; a test pins it.
 *
 * `process.cwd()` here is the Semla *server's* root, not a session's. Nothing
 * in the app calls `process.chdir`, and sessions get their cwd passed to them
 * (see `session-cwd.ts`) rather than by changing the process's. That matters:
 * if this resolved against a session cwd, every repository Semla touched would
 * grow its own workflow state directory — which is the scattering the shared
 * home was introduced to end.
 */
export function semlaStateDir(): string {
  return process.env.SEMLA_STATE_DIR?.trim() || join(process.cwd(), ".semla-state");
}

/**
 * Root of all workflow state, overridable via PI_WORKFLOW_HOME.
 *
 * The override exists because the project key is derived from the cwd while
 * the root was not: a test running against a `mkdtemp` cwd got an isolated
 * key and then wrote it into the operator's real home, where it outlived the
 * temp directory it described. Nothing ever collected those. One run of the
 * suite leaves a directory per temp cwd, and by the time this was noticed
 * `~/.pi/workflows/projects` held 1,931 of them — 127 MB, all but one of them
 * describing a path that no longer exists. The per-directory retention cap in
 * run-persistence.ts cannot help, because each of those holds a single run and
 * the cap is 300 per project.
 *
 * Read on each call rather than captured at import so a test can point it
 * somewhere disposable in a `beforeEach` without controlling module load order.
 *
 * This is `<semla>/.semla-state/workflows`, not a home directory; a home
 * written by either earlier layout is relocated by
 * `migrateLegacyWorkflowHome()`, which this calls at most once per process.
 */
export function workflowHomeDir(): string {
  const override = process.env.PI_WORKFLOW_HOME;
  if (override) return override;
  const home = join(semlaStateDir(), WORKFLOW_STATE_SUBDIR);
  migrateLegacyWorkflowHome(home);
  return home;
}

/** Pre-move locations of the user-level workflow home, newest first. */
export function legacyWorkflowHomeDirs(): string[] {
  return LEGACY_WORKFLOW_HOME_RELATIVE_DIRS.map((dir) => join(homedir(), dir));
}

let migrationAttempted = false;

export interface WorkflowHomeMigration {
  /** Whether a legacy directory was relocated by this call. */
  migrated: boolean;
  /** The legacy directory taken, or undefined when none was eligible. */
  from?: string;
  to: string;
  /** Why nothing moved, when `migrated` is false. */
  reason?: "already-attempted" | "target-exists" | "no-legacy-dir" | "rename-failed";
}

/**
 * Move a pre-existing home-directory workflow home in-repo, once.
 *
 * There are two to consider, because this moved twice: `~/.pi/workflows`
 * originally, then `~/.semla/workflows` briefly. `legacyWorkflowHomeDirs()`
 * orders them newest-first and the first that exists wins, so an operator who
 * ran the intermediate build carries forward the copy they were actually
 * using rather than the older one it had already superseded.
 *
 * A one-time rename rather than a read fallback, because a fallback leaves a
 * home-directory copy permanently live: every read keeps finding it, and the
 * state stays split across two roots with no rule for which is current.
 *
 * Never merges. If the target already exists it is authoritative and the
 * legacy directory is left untouched — merging two `projects/` trees keyed the
 * same way would resurrect runs the retention cap in run-persistence.ts had
 * already collected, and there is no ordering between them to resolve a clash.
 *
 * Attempted at most once per process and never fatal: a failed rename means
 * workflow state starts empty, which costs run history and a settings file,
 * while throwing here would take down every path resolution in the extension.
 *
 * Not called when PI_WORKFLOW_HOME is set — an explicit override is a
 * deliberate destination (a temp dir, in the test suite), not somewhere the
 * operator's real history should be moved into.
 */
export function migrateLegacyWorkflowHome(
  target: string = join(semlaStateDir(), WORKFLOW_STATE_SUBDIR),
  legacyDirs: readonly string[] = legacyWorkflowHomeDirs(),
): WorkflowHomeMigration {
  if (migrationAttempted) {
    return { migrated: false, to: target, reason: "already-attempted" };
  }
  migrationAttempted = true;

  if (existsSync(target)) return { migrated: false, to: target, reason: "target-exists" };

  const legacy = legacyDirs.find((dir) => existsSync(dir));
  if (!legacy) return { migrated: false, to: target, reason: "no-legacy-dir" };

  try {
    mkdirSync(dirname(target), { recursive: true });
    renameSync(legacy, target);
    return { migrated: true, from: legacy, to: target };
  } catch {
    return { migrated: false, from: legacy, to: target, reason: "rename-failed" };
  }
}

/** Test seam: forget that migration was attempted in this process. */
export function resetWorkflowHomeMigrationForTests(): void {
  migrationAttempted = false;
}

/** Parent of every per-project state directory. */
export function workflowProjectsDir(): string {
  return join(workflowHomeDir(), WORKFLOW_PROJECTS_SUBDIR);
}

export function workflowUserSavedDir(): string {
  return join(workflowHomeDir(), "saved");
}

export function workflowProjectKey(cwd: string): string {
  const projectPath = resolve(cwd);
  const slug = sanitizePathSegment(basename(projectPath) || "project");
  const hash = createHash("sha256").update(projectPath).digest("hex").slice(0, 12);
  return `${slug}-${hash}`;
}

export function workflowProjectPaths(cwd: string): WorkflowProjectPaths {
  const key = workflowProjectKey(cwd);
  const rootDir = join(workflowProjectsDir(), key);
  return {
    key,
    rootDir,
    runsDir: join(rootDir, "runs"),
    savedDir: join(rootDir, "saved"),
    settingsPath: join(rootDir, "settings.json"),
    legacyRunsDir: resolve(cwd, WORKFLOW_RUNS_DIR),
    legacySavedDir: resolve(cwd, WORKFLOW_SAVED_DIR),
  };
}

function sanitizePathSegment(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return sanitized || "project";
}
