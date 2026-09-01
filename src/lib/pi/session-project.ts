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
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.types";

/**
 * Every project a session relates to, anchor first.
 *
 * Disk first and authoritative, as everywhere else; the Postgres mirror answers
 * for a session whose record this machine does not have.
 *
 * There used to be a third fallback that rebuilt a link from the old
 * `project_path` column. It is gone: scripts/backfill-session-projects.mjs
 * wrote those links down, and the column itself has been dropped.
 */
export async function sessionProjects(
  id: string,
  /** Injected so a caller that already has a client — or a test with a fake —
   *  is not silently bypassed by one created here. */
  client?: SupabaseClient<Database>,
): Promise<ProjectLink[]> {
  const meta = readSessionMeta(id);
  if (meta) return orderLinks(meta.projects);

  const supabase = client ?? (await createClient());
  const { data: rows } = await supabase
    .from("session_projects")
    .select("project_path, origin, is_primary, first_attached_at, last_touched_at")
    .eq("session_id", id);

  return orderLinks(
    (rows ?? []).map((row) => ({
      path: row.project_path,
      origin: row.origin === "explicit" ? "explicit" : "observed",
      isPrimary: row.is_primary,
      firstAttachedAt: row.first_attached_at,
      lastTouchedAt: row.last_touched_at,
    })),
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
