/**
 * Where in the project the turn's changes are, for the tree under the bucket.
 *
 * The bucket answers "what changed". It cannot answer "where", because a flat
 * list of eight paths gives no sense of the shape of the project they came
 * from — whether the agent touched one corner or scattered edits across four
 * packages. That is what the tree is for, and it only works if a changed file
 * is visible in it without hunting: hence a mark on every changed file, a mark
 * on every directory above one, and an initial expansion that reveals them.
 *
 * Pure and free of React so the path arithmetic — which is where this kind of
 * code goes wrong — is asserted directly.
 */

import type { ChangeStatus, ProjectReview } from "@/lib/review-types";

/**
 * The tree speaks workspace-relative paths and the review speaks
 * project-relative ones. A project link is itself workspace-relative, so the
 * two compose by joining.
 */
export const workspacePathOf = (project: string, path: string) =>
  `${project}/${path}`;

export interface ChangeIndex {
  /** Workspace-relative file path to what happened to it. */
  files: Map<string, ChangeStatus>;
  /** Workspace-relative directory path to how many changes lie beneath it. */
  directories: Map<string, number>;
}

/**
 * Index every project's changes by the paths the tree will ask about.
 *
 * A rename counts at its destination only. The source no longer exists, so
 * there is no tree row to mark — and counting it would make a directory look
 * as though it still held something it does not.
 */
export function indexChanges(
  projects: readonly ProjectReview[],
): ChangeIndex {
  const files = new Map<string, ChangeStatus>();
  const directories = new Map<string, number>();

  for (const project of projects) {
    for (const file of project.changedFiles) {
      const full = workspacePathOf(project.path, file.path);
      files.set(full, file.status);

      // Every ancestor up to and including the project root. Walking the
      // segments rather than the string means a path with a `..` in a name
      // cannot produce a key that looks like an escape.
      const segments = full.split("/");
      for (let depth = segments.length - 1; depth > 0; depth -= 1) {
        const dir = segments.slice(0, depth).join("/");
        directories.set(dir, (directories.get(dir) ?? 0) + 1);
      }
    }
  }

  return { directories, files };
}

/**
 * Beyond this many directories the tree opens at the project root only.
 *
 * A turn that regenerates a lockfile or reformats a package can touch files in
 * fifty directories, and expanding all of them produces a wall with no shape
 * to read — the opposite of what the tree is for. The bucket still lists every
 * file, so nothing is hidden.
 */
export const MAX_AUTO_EXPANDED = 40;

/**
 * Directories to open so the changed files are visible without hunting.
 *
 * Scoped to one project: the tree shows the active project's root, and
 * expanding paths belonging to a repository that is not on screen would be
 * state nobody can see or collapse.
 */
export function directoriesToExpand(
  index: ChangeIndex,
  projectPath: string,
): Set<string> {
  const withinProject = [...index.directories.keys()].filter(
    (dir) => dir === projectPath || dir.startsWith(`${projectPath}/`),
  );

  if (withinProject.length > MAX_AUTO_EXPANDED) {
    return new Set([projectPath]);
  }

  return new Set([projectPath, ...withinProject]);
}
