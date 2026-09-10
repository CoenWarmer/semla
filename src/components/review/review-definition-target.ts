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
import { splitWorkspacePath } from "@/lib/workspace-path";

import type { FileSelection } from "./review-changed-files";

/**
 * Which project a workspace-relative path belongs to, and its path within it.
 *
 * The rule itself lives in `workspace-path.ts` because the file-access timeline
 * resolves the same question on the server, and two implementations of "which
 * project is this in" would eventually disagree — as a scrubber step that opens
 * nothing. This adapts it to the panel's `ProjectReview[]`.
 */
export function selectionForWorkspacePath(
  projects: readonly ProjectReview[],
  workspacePath: string,
): FileSelection | null {
  return splitWorkspacePath(
    projects.map((project) => project.path),
    workspacePath,
  );
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
