import { SessionsListClient } from "@/components/sessions-list-client";
import { createClient } from "@/lib/supabase/server";
import { listSessionMeta } from "@/lib/pi/session-meta";
import { formatSessionDate } from "@/lib/session-date";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.types";

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

  const piIdToSemlaId = new Map(
    piSessions.map((ps) => [ps.id, ps.semla_session_id]),
  );

  const { data: entries } = await supabase
    .from("pi_session_entries")
    .select("pi_session_id, payload")
    .in("pi_session_id", [...piIdToSemlaId.keys()])
    .eq("event_type", "message");

  const usageMap = new Map<string, { tokens: number; cost: number }>();
  for (const entry of entries ?? []) {
    const semlaId = piIdToSemlaId.get(entry.pi_session_id);
    if (!semlaId) continue;
    const payload = entry.payload as Record<string, unknown>;
    const msg = (payload?.entry as Record<string, unknown>)?.message as
      | Record<string, unknown>
      | undefined;
    const usage = msg?.usage as Record<string, unknown> | undefined;
    if (!usage) continue;
    const tokens = Number(usage.totalTokens ?? 0);
    const cost = Number(
      (usage.cost as Record<string, unknown> | undefined)?.total ?? 0,
    );
    if (!tokens && !cost) continue;
    const prev = usageMap.get(semlaId) ?? { tokens: 0, cost: 0 };
    usageMap.set(semlaId, {
      tokens: prev.tokens + tokens,
      cost: prev.cost + cost,
    });
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
    console.error("[sessionsList] Failed to load sessions:", error);
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

  return <SessionsListClient sessions={rows} />;
}
