import { SessionsListClient } from "@/components/sessions-list-client";
import { PI_WORKSPACE_ROOT } from "@/lib/pi/runtime-config";
import { createClient } from "@/lib/supabase/server";
import { sumMessageUsageByPiSession } from "@/lib/pi/message-usage";
import { sumWorkflowUsageBySession } from "@/lib/pi/workflow-usage";
import { addUsage, type SessionUsage } from "@/lib/session-usage";
import { listSessionMeta } from "@/lib/pi/session-meta";
import { formatSessionDate } from "@/lib/session-date";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.types";

/**
 * Per-session token and cost totals, keyed by Semla session id.
 *
 * The summing lives in message-usage.ts, shared with /api/stats/usage. This
 * used to select the whole `payload` column and add it up here, which shipped
 * 3.6 MB on every render of the root layout and — because PostgREST caps a
 * response at 1,000 rows — reported totals computed from about a fifth of the
 * entries.
 */
async function getSessionTokenUsage(
  supabase: SupabaseClient<Database>,
  sessionIds: string[],
): Promise<Map<string, { tokens: number; cost: number }>> {
  if (sessionIds.length === 0) return new Map();

  const { data: piSessions } = await supabase
    .from("pi_sessions")
    .select("id, semla_session_id")
    .in("semla_session_id", sessionIds);

  if (!piSessions?.length) return new Map();

  const byPiSession = await sumMessageUsageByPiSession(
    supabase,
    piSessions.map((piSession) => piSession.id),
  );

  // The subagent half. Absent here, a session that spent most of its budget
  // in a workflow reported the small number — which is what the top bar and
  // this list disagreed about.
  const byWorkflow = await sumWorkflowUsageBySession(supabase, sessionIds);

  const usageMap = new Map<string, SessionUsage>();
  for (const { id, semla_session_id } of piSessions) {
    const total = addUsage(
      usageMap.get(semla_session_id),
      byPiSession.get(id),
      // Only once per Semla session, however many pi_sessions it has: the
      // workflow total is already keyed by the Semla id.
      usageMap.has(semla_session_id)
        ? undefined
        : byWorkflow.get(semla_session_id),
    );

    if (!total.tokens && !total.cost) continue;
    usageMap.set(semla_session_id, total);
  }

  return usageMap;
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
