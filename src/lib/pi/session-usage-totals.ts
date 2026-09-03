/**
 * Per-session totals for anything that shows what a session cost.
 *
 * One implementation because there were three, and all three were wrong in
 * the same way: each decided a session's total was *either* its workflow runs
 * or its conversation, never the sum. The sidebar and the top bar are fixed;
 * this is also what `/api/stats/usage` was doing, filtering to sessions with
 * no runs before summing messages at all.
 *
 * Disk first. The totals are stamped into each session's meta as they are
 * spent, so the common path is a `readFileSync` per session and no query.
 * Postgres is read only for a session written before the stamp existed —
 * whose workflow half cannot be recovered from disk, because a run file
 * records its usage but not its session — and that result is written to disk,
 * so it happens once per session rather than once per render.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { sumMessageUsageByPiSession } from "@/lib/pi/message-usage";
import {
  adoptBackfilledUsage,
  readSessionUsage,
} from "@/lib/pi/session-usage-store";
import { sumWorkflowUsageBySession } from "@/lib/pi/workflow-usage";
import type { Database } from "@/types/database.types";
import {
  addUsage,
  NO_USAGE,
  sessionUsageTotal,
  type SessionUsage,
  type SessionUsageRecord,
} from "@/lib/session-usage";

export async function sessionUsageTotals(
  client: SupabaseClient<Database>,
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

  const { data: piSessions } = await client
    .from("pi_sessions")
    .select("id, semla_session_id")
    .in("semla_session_id", unstamped);

  const byPiSession = await sumMessageUsageByPiSession(
    client,
    (piSessions ?? []).map((piSession) => piSession.id),
  );
  const byWorkflow = await sumWorkflowUsageBySession(client, unstamped);

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

    // Written so the next caller reads disk. Best-effort inside: a total that
    // could not be stamped is recomputed next time, not lost.
    adoptBackfilledUsage(id, record);
    totals.set(id, total);
  }

  return totals;
}

/** Everything these sessions have spent, added up. */
export const totalUsage = (
  totals: ReadonlyMap<string, SessionUsage>,
): SessionUsage => addUsage(...totals.values());
