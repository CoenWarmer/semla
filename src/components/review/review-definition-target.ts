/**
 * Turning a definition's workspace-relative path into something the review
 * panel can open.
 *
 * The panel addresses files as `{ project, path }`, where `path` is relative to
 * the project. A definition does not respect that shape: it can land in another
 * repository of the same session, or in `node_modules` of the one being read,
 * and the server therefore answers in workspace-relative terms. This is where
 * the two are reconciled.
 *
 * Pure and free of React, because the failure mode is path arithmetic — a
 * prefix that matches a sibling directory because its name starts the same way
 * — and that is worth asserting directly rather than through a click.
 */

import type { ProjectReview } from "@/lib/review-types";

import type { FileSelection } from "./review-changed-files";

/**
 * Which project a workspace-relative path belongs to, and its path within it.
 *
 * Segment-wise rather than a string prefix: `semla` prefixes `semla-wiki`, and
 * a check that accepts a sibling repository because its name starts the same
 * way is not a check — the same rule `resolveInsideRoot` states on the server.
 *
 * The longest match wins, so a session that has both a monorepo and one of its
 * packages linked resolves to the package. Null when the path is in none of
 * them, which is an ordinary outcome: a definition can resolve into a
 * dependency outside every linked project.
 */
export function selectionForWorkspacePath(
  projects: readonly ProjectReview[],
  workspacePath: string,
): FileSelection | null {
  let best: FileSelection | null = null;

  for (const project of projects) {
    const prefix = `${project.path}/`;
    if (!workspacePath.startsWith(prefix)) continue;

    const path = workspacePath.slice(prefix.length);
    if (!path) continue;

    if (!best || project.path.length > best.project.length) {
      best = { path, project: project.path };
    }
  }

  return best;
}

/**
 * Whether a file should open without an editable buffer.
 *
 * A declaration file states an interface and a dependency's source is not this
 * repository's to change, so both open for reading. Editing them would produce
 * a diff the review panel cannot show and `npm ci` would erase.
 *
 * Read-only is decided from the path rather than from the definition's own
 * `external` flag so that it also holds when the operator opens the same file
 * again later, by any route.
 */
export function isReadOnlyPath(path: string): boolean {
  return path.endsWith(".d.ts") || path.split("/").includes("node_modules");
}
