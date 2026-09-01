import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { NextResponse } from "next/server";

import { matchScore, rankMatches, type FileMatch } from "@/lib/file-search";
import {
  resolveFileRoot,
  resolveInsideRoot,
  toRelativePath,
} from "@/lib/pi/file-browser";
import { IGNORED_DIRECTORIES } from "@/lib/pi/file-walk";
import { listProjectFiles, mapWithConcurrency } from "@/lib/pi/project-files";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Budgets are per project, not per request. Sharing one pool across the
 * workspace means whichever repository happens to be listed first can spend all
 * of it — which is exactly what a single depth-first walk used to do, returning
 * nothing but a partial sweep of one enormous checkout.
 */
const PROJECT_BUDGET = 200_000;
const PER_PROJECT_BUDGET = 200_000;
const GIT_CONCURRENCY = 8;
const RESULT_LIMIT = 100;

/**
 * Which part of the workspace to search.
 *
 * The two scopes are separate requests rather than one because they finish at
 * very different times. The session's own project answers in well under a
 * second; sweeping every other repository on the machine takes appreciably
 * longer, and folding both into one response held the fast, almost-always-wanted
 * answer behind the slowest thing on disk. Split, the project renders
 * immediately and the wider sweep fills in underneath it.
 */
type Scope = "project" | "workspace";

const parseScope = (raw: string | null): Scope =>
  raw === "workspace" ? "workspace" : "project";

/**
 * A quick, allocation-light test for whether a path could possibly match.
 *
 * `matchScore` is the authority, but it lowercases the whole path to do its
 * job. Nearly every path in a workspace-wide sweep is a miss, so paying for
 * that allocation a million times to reject them is the wrong order of work:
 * this rejects the overwhelming majority on the basename alone, and only falls
 * through to the full path when the name is not enough.
 */
function couldMatch(
  lowerQuery: string,
  prefix: string,
  relativePath: string,
  name: string,
): boolean {
  if (name.toLowerCase().includes(lowerQuery)) return true;
  // A match on the directory part still counts, but is far rarer.
  return (
    relativePath.toLowerCase().includes(lowerQuery) ||
    prefix.toLowerCase().includes(lowerQuery)
  );
}

/** Top-level directories of the workspace, minus one already searched. */
async function workspaceProjects(root: string, exclude: string | null) {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.name.startsWith(".") &&
        !IGNORED_DIRECTORIES.has(entry.name) &&
        join(root, entry.name) !== exclude,
    )
    .map((entry) => join(root, entry.name));
}

/**
 * Filenames matching `q` within one scope.
 *
 * `complete` is false when any project hit its budget. The caller says so rather
 * than presenting a partial sweep as the whole workspace.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const searchParams = new URL(request.url).searchParams;
  const query = (searchParams.get("q") ?? "").trim();
  const scope = parseScope(searchParams.get("scope"));

  const empty = NextResponse.json({ complete: true, matches: [], query, scope });
  if (!query) return empty;

  const { root, basePath } = await resolveFileRoot(id);
  const projectPath = basePath ? resolveInsideRoot(root, basePath) : null;

  // A session with no project has nothing the project scope could return; the
  // workspace scope is then the whole of the search.
  if (scope === "project" && !projectPath) return empty;

  const lowerQuery = query.toLowerCase();
  const inProject = scope === "project";
  const matches: FileMatch[] = [];

  /**
   * Collect matches from one project, whose files arrive relative to it.
   *
   * The workspace-relative path is built by concatenation from a prefix
   * computed once per project. Filtering happens as the paths arrive: a
   * workspace holds far more of them than are worth keeping in memory only to
   * sort and discard at the end.
   */
  const collectorFor = (dir: string) => {
    const prefix = `${toRelativePath(root, dir)}/`;
    return (relativePath: string, name: string) => {
      // Cheap reject first. `matchScore` lowercases the whole path, and doing
      // that for every one of a million paths costs more than the search does.
      if (!couldMatch(lowerQuery, prefix, relativePath, name)) return;

      const path = prefix + relativePath;
      if (matchScore(query, path) !== null) matches.push({ inProject, name, path });
    };
  };

  let complete: boolean;

  if (scope === "project") {
    ({ complete } = await listProjectFiles(projectPath!, collectorFor(projectPath!), {
      budget: PROJECT_BUDGET,
    }));
  } else {
    // The project has its own request; searching it again here would only
    // produce duplicates for the client to strip out.
    const projects = await workspaceProjects(root, projectPath);
    const results = await mapWithConcurrency(projects, GIT_CONCURRENCY, (dir) =>
      listProjectFiles(dir, collectorFor(dir), { budget: PER_PROJECT_BUDGET }),
    );
    complete = results.every((result) => result.complete);
  }

  return NextResponse.json({
    complete,
    matches: rankMatches(query, matches, RESULT_LIMIT),
    query,
    scope,
  });
}
