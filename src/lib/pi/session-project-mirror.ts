/**
 * The Postgres mirror of a session's project links.
 *
 * Disk is authoritative — `SessionMeta.projects` is what every reader consults,
 * and it works when the database does not. This table exists so the relation
 * survives independently of one machine's `.semla-sessions` directory, which
 * makes it a copy rather than a source.
 *
 * That has a consequence worth stating plainly: **a failure here must never
 * fail the caller.** The disk write has already succeeded by the time this
 * runs, so throwing would turn a completed operation into a reported error and
 * leave the user retrying something that actually worked. Failures are logged
 * and swallowed, exactly as the rest of Semla treats Postgres.
 */

import { createAdminClient } from "@/lib/supabase-admin";

import type { ProjectLink } from "@/lib/pi/session-meta";

/**
 * Replace a session's mirrored links with `links`.
 *
 * Delete-then-insert rather than upsert-and-prune, because of the partial
 * unique index that allows one primary per session: upserting a newly promoted
 * anchor before the old one is cleared would momentarily leave two rows with
 * `is_primary`, and the index rejects that. Clearing first means the write
 * never passes through an invalid state.
 *
 * The two statements are not in a transaction — supabase-js has no ergonomic
 * way to open one — so a crash between them leaves the mirror empty for that
 * session. That is recoverable and deliberately tolerated: disk still has the
 * links, and the next write repairs the mirror wholesale.
 */
export async function mirrorSessionProjects(
  sessionId: string,
  links: readonly ProjectLink[],
): Promise<void> {
  try {
    const admin = createAdminClient();

    const { error: deleteError } = await admin
      .from("session_projects")
      .delete()
      .eq("session_id", sessionId);

    if (deleteError) throw new Error(deleteError.message);

    if (links.length === 0) return;

    const { error: insertError } = await admin.from("session_projects").insert(
      links.map((link) => ({
        first_attached_at: link.firstAttachedAt,
        is_primary: link.isPrimary,
        last_touched_at: link.lastTouchedAt,
        origin: link.origin,
        project_path: link.path,
        session_id: sessionId,
      })),
    );

    if (insertError) throw new Error(insertError.message);
  } catch (error) {
    // Includes the case where the migration has not been applied yet, which is
    // why this is a warning rather than anything louder.
    console.warn(
      `[session-projects] Unable to mirror links for ${sessionId}:`,
      error instanceof Error ? error.message : error,
    );
  }
}
