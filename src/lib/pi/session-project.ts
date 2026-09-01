/**
 * The project a session works in, and where that sits inside the workspace.
 *
 * The git route resolved this on its own; the file browser needs the same
 * answer, and two copies of "disk first, then Postgres" is one copy too many.
 */

import { join, relative, sep } from "node:path";

import { PI_WORKSPACE_ROOT } from "@/lib/pi/runtime-config";
import { readSessionMeta, type ProjectLink } from "@/lib/pi/session-meta";
import { orderLinks } from "@/lib/pi/session-project-links";
import { createClient } from "@/lib/supabase/server";

/**
 * The absolute project path for a session, or null when it has none.
 *
 * The disk record is authoritative and works without the database; the Postgres
 * row still answers for sessions created before it existed.
 */
export async function sessionProjectPath(id: string): Promise<string | null> {
  const meta = readSessionMeta(id);
  if (meta) return meta.projectPath ?? null;

  const supabase = await createClient();
  const { data } = await supabase
    .from("sessions")
    .select("project_path")
    .eq("id", id)
    .maybeSingle();
  return data?.project_path ?? null;
}

/**
 * The single link a session written before this relation existed implies.
 *
 * Those records carry `projectPath` and nothing else. Rather than run a
 * one-shot backfill over the session directory, they are converted on read:
 * the workspace root is a runtime value, so read time is the only place that
 * reliably knows how to make the path relative. A record whose project sits
 * outside the root yields no link, which is the same answer the file API gives
 * it.
 *
 * Exported for tests; `sessionProjects` is what callers want.
 */
export function impliedLinks(
  workspaceRoot: string,
  projectPath: string | null,
  at: string,
): ProjectLink[] {
  const path = projectPrefix(workspaceRoot, projectPath);
  if (!path) return [];

  return [
    {
      path,
      origin: "explicit",
      isPrimary: true,
      firstAttachedAt: at,
      lastTouchedAt: at,
    },
  ];
}

/**
 * Every project a session relates to, anchor first.
 *
 * Disk first and authoritative, as everywhere else. The Postgres mirror answers
 * for a session whose record this machine does not have, and `project_path`
 * behind that for rows written before either existed — three fallbacks, each
 * one narrower than the last, so a session never silently loses its projects
 * because of where it was created.
 */
export async function sessionProjects(id: string): Promise<ProjectLink[]> {
  const meta = readSessionMeta(id);
  if (meta) {
    return meta.projects.length > 0
      ? orderLinks(meta.projects)
      : impliedLinks(PI_WORKSPACE_ROOT, meta.projectPath, meta.createdAt);
  }

  const supabase = await createClient();
  const [{ data: rows }, { data: session }] = await Promise.all([
    supabase
      .from("session_projects")
      .select("project_path, origin, is_primary, first_attached_at, last_touched_at")
      .eq("session_id", id),
    supabase.from("sessions").select("project_path, created_at").eq("id", id).maybeSingle(),
  ]);

  if (rows && rows.length > 0) {
    return orderLinks(
      rows.map((row) => ({
        path: row.project_path,
        origin: row.origin === "explicit" ? "explicit" : "observed",
        isPrimary: row.is_primary,
        firstAttachedAt: row.first_attached_at,
        lastTouchedAt: row.last_touched_at,
      })),
    );
  }

  return impliedLinks(
    PI_WORKSPACE_ROOT,
    session?.project_path ?? null,
    session?.created_at ?? new Date().toISOString(),
  );
}

/** A link's absolute path, for the git and wiki readers that shell out. */
export const projectAbsolutePath = (
  link: Pick<ProjectLink, "path">,
  workspaceRoot: string = PI_WORKSPACE_ROOT,
): string => join(workspaceRoot, link.path);

/**
 * The project's path relative to the workspace root, or null when it is not
 * inside it.
 *
 * Every path the file API speaks is relative to the workspace root, so a
 * project outside that root cannot be addressed at all. Rather than escape the
 * root — which is also the only thing stopping a crafted path from reading the
 * whole disk — such a project is reported as absent and the browser falls back
 * to the workspace itself.
 */
export function projectPrefix(
  workspaceRoot: string,
  projectPath: string | null,
): string | null {
  if (!projectPath) return null;

  const rel = relative(workspaceRoot, projectPath);
  if (!rel || rel.startsWith("..") || rel.startsWith(sep)) return null;

  // Normalise to the forward-slash form the rest of the API uses.
  return rel.split(sep).join("/");
}
