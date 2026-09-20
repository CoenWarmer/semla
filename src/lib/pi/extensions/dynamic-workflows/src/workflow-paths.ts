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
  LEGACY_WORKFLOW_HOME_RELATIVE_DIR,
  WORKFLOW_HOME_RELATIVE_DIR,
  WORKFLOW_RUNS_DIR,
  WORKFLOW_SAVED_DIR,
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
 * The default sits under `~/.semla`, not `~/.pi`; a home written before that
 * change is relocated by `migrateLegacyWorkflowHome()`, which this calls at
 * most once per process.
 */
export function workflowHomeDir(): string {
  const override = process.env.PI_WORKFLOW_HOME;
  if (override) return override;
  const home = join(homedir(), WORKFLOW_HOME_RELATIVE_DIR);
  migrateLegacyWorkflowHome(home);
  return home;
}

/** Pre-move location of the user-level workflow home. */
export function legacyWorkflowHomeDir(): string {
  return join(homedir(), LEGACY_WORKFLOW_HOME_RELATIVE_DIR);
}

let migrationAttempted = false;

export interface WorkflowHomeMigration {
  /** Whether the legacy directory was relocated by this call. */
  migrated: boolean;
  from: string;
  to: string;
  /** Why nothing moved, when `migrated` is false. */
  reason?: "already-attempted" | "target-exists" | "no-legacy-dir" | "rename-failed";
}

/**
 * Move a pre-existing `~/.pi/workflows` to the `~/.semla` home, once.
 *
 * A one-time rename rather than a read fallback, because a fallback leaves the
 * host's `pi` directory permanently live: every read would keep finding it,
 * and the state this repository owns would stay mixed in with whatever another
 * `pi` install on the machine writes there. The whole point of the move is
 * that Semla's state is distinguishable from a stranger's.
 *
 * Never merges. If the new home already exists it is authoritative and the
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
  target: string = join(homedir(), WORKFLOW_HOME_RELATIVE_DIR),
  legacy: string = legacyWorkflowHomeDir(),
): WorkflowHomeMigration {
  const result = { from: legacy, to: target };
  if (migrationAttempted) return { ...result, migrated: false, reason: "already-attempted" };
  migrationAttempted = true;

  if (existsSync(target)) return { ...result, migrated: false, reason: "target-exists" };
  if (!existsSync(legacy)) return { ...result, migrated: false, reason: "no-legacy-dir" };

  try {
    mkdirSync(dirname(target), { recursive: true });
    renameSync(legacy, target);
    return { ...result, migrated: true };
  } catch {
    return { ...result, migrated: false, reason: "rename-failed" };
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
