import { SessionsListClient } from "@/components/sessions-list-client";
import { PI_WORKSPACE_ROOT } from "@/lib/pi/runtime-config";
import { createClient } from "@/lib/supabase/server";
import { sumMessageUsageByPiSession } from "@/lib/pi/message-usage";
import {
  adoptBackfilledUsage,
  readSessionUsage,
} from "@/lib/pi/session-usage-store";
import { sumWorkflowUsageBySession } from "@/lib/pi/workflow-usage";
import {
  addUsage,
  NO_USAGE,
  sessionUsageTotal,
  type SessionUsage,
  type SessionUsageRecord,
} from "@/lib/session-usage";
import { listSessionMeta } from "@/lib/pi/session-meta";
import { formatSessionDate } from "@/lib/session-date";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.types";

/**
 * Per-session token and cost totals, keyed by Semla session id.
 *
 * Read from disk, where the totals are stamped as they are spent — the mirror
 * was both slower and behind, since entries are persisted through a queue and
 * this list therefore trailed a turn that had already finished.
 *
 * Postgres is still consulted, but only as the backup it is: a session last
 * written before the stamp existed has no total on disk, and the run files
 * cannot supply the workflow half retroactively because a run records its
 * usage but not its session. Those are summed once from the mirror and written
 * to disk, so it happens per session rather than per render.
 */
async function getSessionTokenUsage(
  supabase: SupabaseClient<Database>,
  sessionIds: readonly string[],
): Promise<Map<string, SessionUsage>> {
  const totals = new Map<string, SessionUsage>();
  const unstamped: string[] = [];

  for (const id of sessionIds) {
    const record = readSessionUsage(id);
    if (record) totals.set(id, sessionUsageTotal(record));
    else unstamped.push(id);
  }

  if (unstamped.length === 0) return totals;

  const { data: piSessions } = await supabase
    .from("pi_sessions")
    .select("id, semla_session_id")
    .in("semla_session_id", unstamped);

  const byPiSession = await sumMessageUsageByPiSession(
    supabase,
    (piSessions ?? []).map((piSession) => piSession.id),
  );
  const byWorkflow = await sumWorkflowUsageBySession(supabase, unstamped);

  const conversationBySession = new Map<string, SessionUsage>();
  for (const { id, semla_session_id } of piSessions ?? []) {
    conversationBySession.set(
      semla_session_id,
      addUsage(conversationBySession.get(semla_session_id), byPiSession.get(id)),
    );
  }

  for (const id of unstamped) {
    const record: SessionUsageRecord = {
      conversation: conversationBySession.get(id) ?? NO_USAGE,
      priorRuns: byWorkflow.get(id) ?? NO_USAGE,
      runs: {},
    };

    const total = sessionUsageTotal(record);
    if (!total.tokens && !total.cost) continue;

    // Written so the next render reads disk. Best-effort inside: a total that
    // could not be stamped is recomputed next time, not lost.
    adoptBackfilledUsage(id, record);
    totals.set(id, total);
  }

  return totals;
}

export async function SessionsList() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return null;
  }

  const { data: dbRows, error } = await supabase
    .from("sessions")
    .select("id, created_at, title, is_running")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  // Disk records answer first, so the list survives a database outage. Rows
  // that only Postgres knows about — sessions created before the records
  // existed — are folded in behind them.
  const onDisk = listSessionMeta().filter((meta) => meta.userId === user.id);
  const seen = new Set(onDisk.map((meta) => meta.id));
  const sessions = [
    ...onDisk.map((meta) => ({
      created_at: meta.createdAt,
      id: meta.id,
      is_running: meta.isRunning,
      title: meta.title,
    })),
    ...(dbRows ?? []).filter((row) => !seen.has(row.id)),
  ].sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));

  if (error && sessions.length === 0) {
    console.error("[sessions-list] Failed to load sessions:", error);
    return (
      <p className="text-destructive text-sm">
        Failed to load sessions. Please refresh the page.
      </p>
    );
  }

  if (!sessions?.length) {
    return null;
  }

  const usageBySession = await getSessionTokenUsage(
    supabase,
    sessions.map((s) => s.id),
  );

  const rows = sessions.map(({ id, created_at, title, is_running }) => ({
    id,
    createdAt: created_at,
    date: formatSessionDate(created_at),
    isRunning: is_running ?? false,
    title,
    usage: usageBySession.get(id),
  }));

  // Handed down rather than sent with every project of every status poll: it is
  // one value for the whole machine, and this component is already on the server.
  return <SessionsListClient sessions={rows} workspaceRoot={PI_WORKSPACE_ROOT} />;
}
