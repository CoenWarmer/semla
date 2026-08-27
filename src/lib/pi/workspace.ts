import { execFile } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";

import { PI_WORKSPACE_ROOT } from "./runtime-config";

const execFileAsync = promisify(execFile);

/**
 * Cap on concurrent `git` subprocesses. The workspace root routinely holds
 * dozens of repos, and spawning a process for every one at once spikes CPU on
 * the same machine that is serving the app.
 */
const GIT_CONCURRENCY = 8;

/**
 * The sidebar's project combobox mounts on every page, so this list is asked
 * for constantly while it only changes when a repo is committed to. A short TTL
 * keeps the common case free without making the list feel stale.
 */
const CACHE_TTL_MS = 5_000;

export type WorkspaceProject = {
  name: string;
  path: string;
  branch: string | null;
  lastCommitAt: number | null;
  stalenessText: string;
};

function formatStaleness(lastCommitAt: number | null, now: number): string {
  if (lastCommitAt === null) return "no commits";
  const diffMs = now - lastCommitAt * 1000;
  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes < 2) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  const diffWeeks = Math.floor(diffDays / 7);
  if (diffWeeks < 5) return `${diffWeeks}w ago`;
  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths < 12) return `${diffMonths}mo ago`;
  return `${Math.floor(diffDays / 365)}y ago`;
}

/** Map `items` concurrently, at most `limit` at a time, preserving order. */
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

const git = async (cwd: string, args: string[]): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 2000,
    });
    return stdout.trim() || null;
  } catch {
    // Not a valid git repo, no commits yet, or the call timed out.
    return null;
  }
};

const isRepo = async (path: string): Promise<boolean> => {
  try {
    await access(join(path, ".git"));
    return true;
  } catch {
    return false;
  }
};

let cache: { at: number; value: WorkspaceProject[] } | null = null;
let inFlight: Promise<WorkspaceProject[]> | null = null;

/**
 * Projects in the workspace root, with each one's branch and last commit time.
 *
 * Async on purpose. This used to shell out with `execSync` twice per repo,
 * which blocks the Node event loop outright — with 42 repos that was ~1.7s
 * during which the server could not progress *any* other request, so a single
 * page load stalled every API call behind it. The work itself was never the
 * problem; doing it synchronously was.
 */
export async function getWorkspaceProjects(): Promise<WorkspaceProject[]> {
  const now = Date.now();

  if (cache && now - cache.at < CACHE_TTL_MS) return cache.value;
  // Collapse concurrent callers (the sidebar and a server render can ask at the
  // same moment) onto one filesystem sweep.
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const entries = await readdir(PI_WORKSPACE_ROOT, { withFileTypes: true });
      const candidates = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(PI_WORKSPACE_ROOT, entry.name));
      const repoFlags = await mapWithConcurrency(
        candidates,
        GIT_CONCURRENCY,
        isRepo,
      );
      const repos = candidates.filter((_, index) => repoFlags[index]);

      const value = await mapWithConcurrency(
        repos,
        GIT_CONCURRENCY,
        async (path): Promise<WorkspaceProject> => {
          const [branch, timestamp] = await Promise.all([
            git(path, ["branch", "--show-current"]),
            git(path, ["log", "-1", "--format=%ct"]),
          ]);
          const lastCommitAt = timestamp ? parseInt(timestamp, 10) : null;

          return {
            name: basename(path),
            path,
            branch,
            lastCommitAt,
            stalenessText: formatStaleness(lastCommitAt, now),
          };
        },
      );

      cache = { at: Date.now(), value };
      return value;
    } catch {
      return [];
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}
