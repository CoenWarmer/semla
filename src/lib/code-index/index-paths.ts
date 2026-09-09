/**
 * Where a project's index lives on disk.
 *
 * Rooted at an overridable home for the same reason `PI_WORKFLOW_HOME` exists
 * in workflow-paths.ts, and with the same incident behind it: state keyed by a
 * `mkdtemp` cwd but rooted at the real home directory outlives the temp
 * directory it describes, and nothing collects it. That left 1,931 project
 * directories and 127 MB in `~/.pi/workflows/projects`. An index is far larger
 * per project than a workflow run — ~12 MB for a repository this size — so the
 * same mistake here is measured in gigabytes.
 *
 * The slug+hash key deliberately mirrors `workflowProjectKey()` rather than
 * importing it: these are separate namespaces that never have to agree, and a
 * shared function would make `src/lib/` depend on a vendored extension tree for
 * nothing more than a naming convention.
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import type { ProjectKey } from "./types";

/** Root of all index state, overridable via SEMLA_INDEX_HOME. */
export function indexHomeDir(): string {
  // Read per call, not captured at import, so a test can point it somewhere
  // disposable without controlling module load order.
  return process.env.SEMLA_INDEX_HOME ?? join(homedir(), ".semla", "index");
}

/** Stable namespace for a project, derived from its absolute path. */
export function projectKey(projectRoot: string): ProjectKey {
  const absolute = resolve(projectRoot);
  const slug = sanitizeSegment(basename(absolute) || "project");
  const hash = createHash("sha256").update(absolute).digest("hex").slice(0, 12);
  return `${slug}-${hash}` as ProjectKey;
}

/** Directory holding one project's index files. */
export function projectIndexDir(key: ProjectKey): string {
  return join(indexHomeDir(), key);
}

export interface ProjectIndexPaths {
  dir: string;
  /** Flat Float32Array of `chunks * dim` values, row-major. */
  vectors: string;
  /** One JSON object per line, parallel to the vector rows. */
  chunks: string;
  /** IndexHead: model identity, Merkle root, counts. */
  head: string;
}

export function projectIndexPaths(key: ProjectKey): ProjectIndexPaths {
  const dir = projectIndexDir(key);
  return {
    dir,
    vectors: join(dir, "vectors.bin"),
    chunks: join(dir, "chunks.jsonl"),
    head: join(dir, "head.json"),
  };
}

function sanitizeSegment(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return sanitized || "project";
}
