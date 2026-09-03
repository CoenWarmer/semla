import { SessionsListClient } from "@/components/sessions-list-client";
import { PI_WORKSPACE_ROOT } from "@/lib/pi/runtime-config";
import { createClient } from "@/lib/supabase/server";
import { sessionUsageTotals } from "@/lib/pi/session-usage-totals";
import { listSessionMeta } from "@/lib/pi/session-meta";
import { formatSessionDate } from "@/lib/session-date";

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

  const usageBySession = await sessionUsageTotals(
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
