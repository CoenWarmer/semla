import { handleRouteError } from "@/lib/api-helpers";
import { createAdminClient } from "@/lib/supabase-admin";
import { createClient } from "@/lib/supabase/server";
import { snapshotFromRunFile } from "@/lib/pi/workflow-service";

export const runtime = "nodejs";

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }

  try {
    const admin = createAdminClient();

    // All sessions for this user
    const { data: sessions, error: sessionsError } = await admin
      .from("sessions")
      .select("id")
      .eq("user_id", user.id);

    if (sessionsError) throw new Error(sessionsError.message);
    const sessionIds = (sessions ?? []).map((s) => s.id);
    if (sessionIds.length === 0) return Response.json({ cost: 0, tokens: 0 });

    // All workflow runs for those sessions
    const { data: runs, error: runsError } = await admin
      .from("workflow_runs")
      .select("run_id, semla_session_id, snapshot")
      .in("semla_session_id", sessionIds);

    if (runsError) throw new Error(runsError.message);

    let runCost = 0;
    let runTokens = 0;
    const sessionIdsWithRuns = new Set<string>();

    for (const run of runs ?? []) {
      sessionIdsWithRuns.add(run.semla_session_id);
      const liveSnapshot = snapshotFromRunFile(run.run_id);
      const snapshot = (liveSnapshot ?? run.snapshot) as {
        tokenUsage?: { cost?: number; total?: number };
      };
      runCost += snapshot?.tokenUsage?.cost ?? 0;
      runTokens += snapshot?.tokenUsage?.total ?? 0;
    }

    // For sessions with no workflow runs, sum per-message costs
    const pureSessionIds = sessionIds.filter((id) => !sessionIdsWithRuns.has(id));
    let msgCost = 0;
    let msgTokens = 0;

    if (pureSessionIds.length > 0) {
      // Resolve pi_session IDs for those sessions
      const { data: piSessions, error: piError } = await admin
        .from("pi_sessions")
        .select("id")
        .in("semla_session_id", pureSessionIds);

      if (piError) throw new Error(piError.message);
      const piSessionIds = (piSessions ?? []).map((s) => s.id);

      if (piSessionIds.length > 0) {
        const { data: entries, error: entriesError } = await admin
          .from("pi_session_entries")
          .select("payload")
          .in("pi_session_id", piSessionIds)
          .eq("event_type", "message");

        if (entriesError) throw new Error(entriesError.message);

        for (const entry of entries ?? []) {
          const payload = entry.payload as {
            entry?: {
              message?: { role?: string; usage?: { cost?: { total?: number }; totalTokens?: number } };
            };
          };
          const message = payload.entry?.message;
          if (message?.role !== "assistant") continue;
          msgCost += message.usage?.cost?.total ?? 0;
          msgTokens += message.usage?.totalTokens ?? 0;
        }
      }
    }

    return Response.json({
      cost: runCost + msgCost,
      tokens: runTokens + msgTokens,
    });
  } catch (error) {
    return handleRouteError(error, "Unable to compute usage stats.");
  }
}
