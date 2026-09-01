/**
 * The project a session works in, and where that sits inside the workspace.
 *
 * The git route resolved this on its own; the file browser needs the same
 * answer, and two copies of "disk first, then Postgres" is one copy too many.
 */

import { relative, sep } from "node:path";

import { readSessionMeta } from "@/lib/pi/session-meta";
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
