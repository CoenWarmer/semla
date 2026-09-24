import { requireUser } from "@/lib/api/api-helpers";
import { PI_WORKSPACE_ROOT } from "@/lib/pi/runtime/runtime-config";
import { sessionUsageTotals } from "@/lib/pi/session/session-usage-totals";
import { listSessionsForUser } from "@/lib/pi/session/session-list";
import { formatSessionDate } from "@/lib/session/session-date";
import { SessionsListClient } from "./sessions-list-client";

export async function SessionsList() {
  // Through the shared helper, not a bare auth.getUser(): bound to loopback
  // there is nobody to authenticate, and asking Supabase who it is answered
  // null there, which emptied the sidebar even though sessions existed on disk
  // and in Postgres. Every other route already reads the user this way.
  const { supabase, user } = await requireUser();

  const { sessions, error } = await listSessionsForUser(supabase, user.id);

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

  const rows = sessions.map(({ id, createdAt, title, isRunning }) => ({
    id,
    createdAt,
    date: formatSessionDate(createdAt),
    isRunning,
    title,
    usage: usageBySession.get(id),
  }));

  // Handed down rather than sent with every project of every status poll: it is
  // one value for the whole machine, and this component is already on the server.
  return (
    <SessionsListClient sessions={rows} workspaceRoot={PI_WORKSPACE_ROOT} />
  );
}
