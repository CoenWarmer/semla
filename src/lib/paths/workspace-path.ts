/**
 * Splitting a workspace-relative path into the project that owns it.
 *
 * Two callers need this rule and must not drift apart: the review panel, which
 * addresses files as `{ project, path }` and runs in the browser, and the
 * file-access timeline, which resolves an agent's tool arguments on the server.
 * A second implementation of "which project is this in" would eventually
 * disagree with the first, and the disagreement would show up as a scrubber
 * step that opens nothing.
 *
 * No `node:path` import, deliberately: this module is reachable from client
 * components, and the arithmetic is string work that does not need it.
 */

export interface WorkspaceSplit {
  /** Workspace-relative project path — the identity. See project-of-path.ts. */
  project: string;
  /** Path within that project. Never empty. */
  path: string;
}

/**
 * Which project a workspace-relative path belongs to, and its path within it.
 *
 * Segment-wise rather than a string prefix: `semla` prefixes `semla-wiki`, and
 * a check that accepts a sibling repository because its name starts the same
 * way is not a check.
 *
 * The longest match wins, so a session with both a monorepo and one of its
 * packages linked resolves to the package. Null when the path is in none of
 * them, which is an ordinary outcome rather than an error — an agent reads
 * `node_modules` and other repositories all the time.
 */
export function splitWorkspacePath(
  projects: readonly string[],
  workspacePath: string,
): WorkspaceSplit | null {
  let best: WorkspaceSplit | null = null;

  for (const project of projects) {
    const prefix = `${project}/`;
    if (!workspacePath.startsWith(prefix)) continue;

    const path = workspacePath.slice(prefix.length);
    if (!path) continue;

    if (!best || project.length > best.project.length) {
      best = { path, project };
    }
  }

  return best;
}
