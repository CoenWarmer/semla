/**
 * Filesystem layout for pi-dynamic-workflows state.
 *
 * New writes live under the user's workflow home so projects do not get
 * scattered `.pi/workflows` directories. Project-scoped state is still isolated
 * by a stable cwd-derived namespace.
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { WORKFLOW_RUNS_DIR, WORKFLOW_SAVED_DIR } from "./config.ts";

export const WORKFLOW_HOME_RELATIVE_DIR = ".pi/workflows";
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
 */
export function workflowHomeDir(): string {
  return process.env.PI_WORKFLOW_HOME ?? join(homedir(), WORKFLOW_HOME_RELATIVE_DIR);
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
