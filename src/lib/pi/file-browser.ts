/**
 * What the file-browser routes share: where a session's files start, and how a
 * client-supplied path is turned into one on disk without leaving the root.
 *
 * Every path crossing this API is relative to the workspace root, one
 * coordinate system for listing, reading and search alike. The browser opening
 * inside a project is a matter of which path it *starts* at, not a second kind
 * of path — so a search result outside the project is still readable by the
 * content route without translation.
 */

import { readdir } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import { PI_WORKSPACE_ROOT } from "@/lib/pi/runtime-config";
import { projectPrefix, sessionProjectPath } from "@/lib/pi/session-project";
import { createClient } from "@/lib/supabase/server";

export type FileEntry = {
  name: string;
  path: string;
  type: "file" | "directory";
};

export type FileRoot = {
  /** Absolute workspace root; every relative path is resolved against it. */
  root: string;
  /**
   * The session's project as a workspace-relative path, or null when the
   * session has no project or it lies outside the workspace root.
   */
  basePath: string | null;
};

/** Where a session's file browser is rooted, and where it should open. */
export async function resolveFileRoot(sessionId: string): Promise<FileRoot> {
  const supabase = await createClient();
  const [{ data: piSession }, projectPath] = await Promise.all([
    supabase
      .from("pi_sessions")
      .select("workspace_root")
      .eq("semla_session_id", sessionId)
      .maybeSingle(),
    sessionProjectPath(sessionId),
  ]);

  const root = piSession?.workspace_root ?? PI_WORKSPACE_ROOT;
  return { root, basePath: projectPrefix(root, projectPath) };
}

/**
 * Resolve a workspace-relative path to an absolute one, or null if it escapes.
 *
 * Containment is checked with `relative` rather than a string prefix: `/Dev`
 * prefixes `/Devil`, and a check that accepts a sibling directory because its
 * name starts the same way is not a check.
 */
export function resolveInsideRoot(root: string, relPath: string): string | null {
  if (isAbsolute(relPath)) return null;

  const absolutePath = relPath ? join(root, relPath) : root;
  const rel = relative(root, absolutePath);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;

  return absolutePath;
}

/** Workspace-relative form of an absolute path inside `root`. */
export function toRelativePath(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split(sep).join("/");
}

/**
 * One directory's entries, directories first then files, each alphabetical.
 *
 * Dotted names are left out: the browser is for reading a project's source, and
 * the dot directories in a workspace root are caches and VCS internals.
 */
export async function listDirectory(
  absolutePath: string,
  relPath: string,
): Promise<FileEntry[]> {
  const entries = await readdir(absolutePath, { withFileTypes: true });

  return entries
    .filter((entry) => !entry.name.startsWith("."))
    .map((entry) => ({
      name: entry.name,
      path: relPath ? `${relPath}/${entry.name}` : entry.name,
      type: (entry.isDirectory() ? "directory" : "file") as "file" | "directory",
    }))
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}
