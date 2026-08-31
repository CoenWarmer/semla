import type { GitStatus } from "@/lib/git-status-display";

import { fetchCanonical, readGitStatus } from "./git-status";
import { getWorkspaceProjects } from "./workspace";

/**
 * Branch and divergence for every project in the workspace, for the home page.
 *
 * Kept apart from getWorkspaceProjects even though it walks the same list. That
 * one feeds the sidebar combobox, which mounts on every page and needs only
 * names and paths; this costs roughly half a second across forty-two
 * repositories, and there is no reason to spend it rendering a session.
 *
 * Nothing here fetches. A card is one of dozens on screen, and reading them all
 * must not mean opening dozens of network connections — the popover fetches the
 * single repository you actually opened.
 */

const CACHE_TTL_MS = 5_000;
const CONCURRENCY = 8;

let cache: { at: number; value: Record<string, GitStatus> } | null = null;
let inFlight: Promise<Record<string, GitStatus>> | null = null;

/** Map `items` concurrently, at most `limit` at a time. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

export async function getWorkspaceGitStatus(): Promise<
  Record<string, GitStatus>
> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.value;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const projects = await getWorkspaceProjects();
      const statuses = await mapWithConcurrency(
        projects,
        CONCURRENCY,
        (project) => readGitStatus(project.path, { fetch: false }),
      );

      const value: Record<string, GitStatus> = {};
      projects.forEach((project, index) => {
        value[project.path] = statuses[index];
      });

      cache = { at: Date.now(), value };
      return value;
    } catch {
      return {};
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/**
 * Whether `path` is a project this workspace actually holds.
 *
 * The guard for every path arriving from a browser. Actions write to a
 * repository, so the path they act on has to be one the workspace already
 * listed rather than any directory a request cares to name.
 */
export async function isWorkspaceProject(path: string): Promise<boolean> {
  const projects = await getWorkspaceProjects();
  return projects.some((project) => project.path === path);
}

/**
 * Fetch one project's canonical branch and wait, for a card whose popover just
 * opened. Clears the workspace cache so the next read sees the new refs.
 */
export async function refreshProject(path: string): Promise<void> {
  await fetchCanonical(path);
  cache = null;
}
