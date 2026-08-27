import { handleRouteError } from "@/lib/api-helpers";
import { snapshotFromRunFile } from "@/lib/pi/workflow-service";
import { createServerTiming } from "@/lib/server-timing";
import { createAdminClient } from "@/lib/supabase-admin";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

type RunUsage = { tokenUsage?: { cost?: number; total?: number } };

// Only the usage subtree of each assistant message, not the whole entry. The
// payload column holds the full pi entry — message text, tool results and all —
// and summing cost in JS meant transferring every byte of it: 2.9MB across 694
// rows, of which 359 were non-assistant rows discarded on arrival. Postgres
// extracts the subtree and applies the role filter instead, for 84KB.
const MESSAGE_USAGE_COLUMN = "usage:payload->entry->message->usage";
const MESSAGE_ROLE_PATH = "payload->entry->message->>role";

export async function GET() {
  const timing = createServerTiming();
  const withTiming = (body: unknown, status = 200) =>
    Response.json(body, {
      headers: { "Server-Timing": timing.header() },
      status,
    });

  try {
    const supabase = await createClient();

    // The proxy (src/proxy.ts) already verified this request's JWT, and the
    // project signs with ES256, so getClaims() verifies locally against a
    // cached JWKS instead of making an auth.getUser() round-trip. The user id
    // still scopes every query below: this route uses the admin client, which
    // bypasses RLS, so the `user_id` filter is doing real work here.
    const { data: claimsData } = await timing.phase("auth", () =>
      supabase.auth.getClaims(),
    );
    const userId = claimsData?.claims.sub;

    if (!userId) {
      return withTiming({ error: "Authentication required." }, 401);
    }

    const admin = createAdminClient();

    // All sessions for this user
    const { data: sessions, error: sessionsError } = await timing.phase(
      "db-sessions",
      () => admin.from("sessions").select("id").eq("user_id", userId),
    );

    if (sessionsError) throw new Error(sessionsError.message);
    const sessionIds = (sessions ?? []).map((s) => s.id);
    if (sessionIds.length === 0) return withTiming({ cost: 0, tokens: 0 });

    // All workflow runs for those sessions. `snapshot` is deliberately not
    // selected: the on-disk run file overrides it below, so fetching it up
    // front shipped 1.75MB of JSONB per request only to discard it. Runs with
    // no file on disk fall back to a second, targeted query.
    const { data: runs, error: runsError } = await timing.phase("db-runs", () =>
      admin
        .from("workflow_runs")
        .select("run_id,semla_session_id")
        .in("semla_session_id", sessionIds),
    );

    if (runsError) throw new Error(runsError.message);

    const runRows = runs ?? [];
    const sessionIdsWithRuns = new Set(
      runRows.map((run) => run.semla_session_id),
    );

    const fromDisk = await timing.phase("disk", () =>
      runRows.map((run) => ({
        runId: run.run_id,
        usage: snapshotFromRunFile(run.run_id) as RunUsage | null,
      })),
    );

    const missing = fromDisk
      .filter((entry) => !entry.usage)
      .map((entry) => entry.runId);

    if (missing.length > 0) {
      const { data: storedRows, error: storedError } = await timing.phase(
        "db-snapshots",
        () =>
          admin
            .from("workflow_runs")
            .select("run_id,snapshot")
            .in("run_id", missing),
      );

      if (storedError) throw new Error(storedError.message);

      const stored = new Map(
        (storedRows ?? []).map((row) => [
          row.run_id,
          row.snapshot as RunUsage | null,
        ]),
      );
      for (const entry of fromDisk) {
        entry.usage ??= stored.get(entry.runId) ?? null;
      }
    }

    let runCost = 0;
    let runTokens = 0;
    for (const { usage } of fromDisk) {
      runCost += usage?.tokenUsage?.cost ?? 0;
      runTokens += usage?.tokenUsage?.total ?? 0;
    }

    // For sessions with no workflow runs, sum per-message costs
    const pureSessionIds = sessionIds.filter(
      (id) => !sessionIdsWithRuns.has(id),
    );
    let msgCost = 0;
    let msgTokens = 0;

    if (pureSessionIds.length > 0) {
      // Resolve pi_session IDs for those sessions
      const { data: piSessions, error: piError } = await timing.phase(
        "db-pi-sessions",
        () =>
          admin
            .from("pi_sessions")
            .select("id")
            .in("semla_session_id", pureSessionIds),
      );

      if (piError) throw new Error(piError.message);
      const piSessionIds = (piSessions ?? []).map((s) => s.id);

      if (piSessionIds.length > 0) {
        const { data: entries, error: entriesError } = await timing.phase(
          "db-entries",
          () =>
            admin
              .from("pi_session_entries")
              .select(MESSAGE_USAGE_COLUMN)
              .in("pi_session_id", piSessionIds)
              .eq("event_type", "message")
              .filter(MESSAGE_ROLE_PATH, "eq", "assistant"),
        );

        if (entriesError) throw new Error(entriesError.message);

        for (const entry of entries ?? []) {
          const usage = (entry as { usage?: unknown }).usage as
            | { cost?: { total?: number }; totalTokens?: number }
            | null;
          msgCost += usage?.cost?.total ?? 0;
          msgTokens += usage?.totalTokens ?? 0;
        }
      }
    }

    return withTiming({
      cost: runCost + msgCost,
      tokens: runTokens + msgTokens,
    });
  } catch (error) {
    return handleRouteError(error, "Unable to compute usage stats.");
  }
}
