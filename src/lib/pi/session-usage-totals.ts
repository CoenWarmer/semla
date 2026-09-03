/**
 * Per-session totals for anything that shows what a session cost.
 *
 * One implementation because there were three, and all three were wrong in
 * the same way: each decided a session's total was *either* its workflow runs
 * or its conversation, never the sum. The sidebar and the top bar are fixed;
 * this is also what `/api/stats/usage` was doing, filtering to sessions with
 * no runs before summing messages at all.
 *
 * Disk first, and from the right place on disk for each half. The
 * conversation is stamped into the session's meta as it is spent, so it costs
 * a `readFileSync` and no query. The workflow half comes from the run files,
 * because the `workflow_runs` snapshot column is only kept current for
 * foreground runs — trusting it made this disagree with the header by one
 * agent's worth of tokens.
 *
 * Postgres answers only for a session with neither: no stamp and no run index,
 * meaning one written before they existed. That result is written to disk, so
 * it happens once per session rather than once per render.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { sumMessageUsageByPiSession } from "@/lib/pi/message-usage";
import {
  adoptBackfilledUsage,
  readSessionUsage,
} from "@/lib/pi/session-usage-store";
import { sumWorkflowUsageBySession } from "@/lib/pi/workflow-usage";
import { workflowUsageFromDisk } from "@/lib/pi/workflow-usage-disk";
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
    // The run files, not the stamp, and not the mirror. A run's snapshot in
    // Postgres is only kept current for foreground runs, so a background run
    // is recorded there as it stood partway through — 5,361 tokens against
    // the run file's 9,052 on the session that exposed this.
    const workflow = workflowUsageFromDisk(id);

    if (record) {
      totals.set(
        id,
        addUsage(
          record.conversation,
          // `priorRuns` only when disk has no index for this session: it was
          // recovered from the mirror, and where the index exists the run
          // files are both fresher and complete.
          workflow.indexed ? workflow.usage : record.priorRuns,
        ),
      );
      continue;
    }

    unstamped.push(id);
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
    const workflow = workflowUsageFromDisk(id);
    const record: SessionUsageRecord = {
      conversation: conversationBySession.get(id) ?? NO_USAGE,
      // Disk when it has the runs; the mirror only for a session with no
      // index, which is one that predates it.
      priorRuns: workflow.indexed
        ? workflow.usage
        : (byWorkflow.get(id) ?? NO_USAGE),
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
