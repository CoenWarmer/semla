/**
 * The bare list of a user's sessions, merged from disk and Postgres.
 *
 * Shared because two callers now need the same merge: the sidebar's server
 * component (which layers usage totals on top) and the `/api/sessions` GET
 * route (which does not). Disk records answer first, so the list survives a
 * database outage; rows that only Postgres knows about — sessions created
 * before the on-disk record existed — are folded in behind them.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { listSessionMeta } from "@/lib/pi/session/session-meta";
import type { Database } from "@/types/database.types";

export type SessionListRow = {
  id: string;
  createdAt: string;
  title: string | null;
  isRunning: boolean;
};

export async function listSessionsForUser(
  client: SupabaseClient<Database>,
  userId: string,
): Promise<{ sessions: SessionListRow[]; error: unknown }> {
  const onDisk = listSessionMeta().filter((meta) => meta.userId === userId);
  const seen = new Set(onDisk.map((meta) => meta.id));

  const { data: dbRows, error } = await client
    .from("sessions")
    .select("id, created_at, title, is_running")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  const sessions: SessionListRow[] = [
    ...onDisk.map((meta) => ({
      createdAt: meta.createdAt,
      id: meta.id,
      isRunning: meta.isRunning,
      title: meta.title,
    })),
    ...(dbRows ?? [])
      .filter((row) => !seen.has(row.id))
      .map((row) => ({
        createdAt: row.created_at,
        id: row.id,
        isRunning: row.is_running,
        title: row.title,
      })),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return { error, sessions };
}
