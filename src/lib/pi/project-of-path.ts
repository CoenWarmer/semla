/**
 * Which workspace project a path belongs to.
 *
 * Used to turn a file the agent just wrote into the project that should be
 * attached to the session. The agent runs with `cwd` set to the workspace root,
 * so the paths it hands to `edit` and `write` are either absolute or relative
 * to that root, and both have to resolve to the same answer.
 *
 * Deliberately *not* a walk up to the nearest `.git`. A project in Semla is a
 * directory one level below the workspace root — that is what
 * `getWorkspaceProjects()` scans, and what the combobox, the project cards, the
 * file browser and `isWorkspaceProject()` all mean by the word. Resolving to
 * anything else invents projects the rest of the app cannot address: a badge
 * with no combobox entry, and git actions that refuse it with a 400.
 *
 * The consequence is that a write inside a nested checkout — this workspace
 * really does hold `semantic-code-search/.repos/elastic_kibana` — attaches
 * `semantic-code-search`. That is coarser than the truth, and it is the
 * trade made knowingly: one definition of "project" everywhere beats sub-repo
 * precision that only this module would understand.
 *
 * Because a project is a first-level directory, resolution is a path split and
 * a lookup rather than any filesystem access at all.
 */

import { relative, resolve, sep } from "node:path";

import { PI_WORKSPACE_ROOT } from "@/lib/pi/runtime-config";
import { getWorkspaceProjects } from "@/lib/pi/workspace";

/**
 * The project owning `path`, as a workspace-relative path, or null.
 *
 * Null covers every way a path can fail to name a project: empty, outside the
 * workspace root, the root itself, or inside a first-level directory that is
 * not a repository. None of those is an error — most tool calls in a session
 * touch something that is not a project, and the caller simply attaches
 * nothing.
 *
 * `projects` is passed in rather than read here so this stays pure and the
 * caller decides how fresh the workspace listing needs to be.
 */
export function projectOfPath(
  path: string,
  workspaceRoot: string,
  projects: ReadonlySet<string>,
): string | null {
  if (!path) return null;

  // resolve() ignores the base when the path is already absolute, so this
  // handles both shapes without asking which one it was given.
  const rel = relative(workspaceRoot, resolve(workspaceRoot, path));

  // Empty means the root itself. A leading ".." (or separator) means the path
  // climbed out of the workspace, which is the same refusal the file API makes
  // rather than addressing something outside the root.
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) {
    return null;
  }

  const [head] = rel.split(sep);
  return head && projects.has(head) ? head : null;
}

/**
 * `projectOfPath` against the live workspace listing.
 *
 * `getWorkspaceProjects()` caches for 5s and collapses concurrent callers, so
 * calling this once per write tool call costs a map lookup in the common case.
 */
export async function projectOfWrittenPath(
  path: string,
  workspaceRoot: string = PI_WORKSPACE_ROOT,
): Promise<string | null> {
  const projects = await getWorkspaceProjects();
  return projectOfPath(
    path,
    workspaceRoot,
    new Set(projects.map((project) => project.name)),
  );
}
