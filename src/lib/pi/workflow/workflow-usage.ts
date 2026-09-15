/**
 * Token and cost totals from a session's workflow runs.
 *
 * The subagent half of what a session cost; `message-usage.ts` is the
 * conversation half, and `session-usage.ts` says why both are needed.
 *
 * Written against the same two lessons that module records, because the table
 * here is worse on both counts. `snapshot` holds an entire run — every agent,
 * its prompt, its result — so selecting it to add up two numbers ships the lot;
 * Postgres extracts the `tokenUsage` subtree instead. And the row cap is not
 * hypothetical at this scale: `workflow_runs` had 2,691 rows on the machine
 * this was written on, so a sidebar listing every session would have summed an
 * arbitrary 1,000 of them and called it a total.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/types/database.types";
import { type SessionUsage, NO_USAGE } from "@/lib/session-usage";

/** Only the usage subtree, named so the row reads as `{ usage }`. */
const USAGE_COLUMN = "semla_session_id,usage:snapshot->tokenUsage";

/** PostgREST's default `max-rows`. Asking for more returns this many. */
const PAGE = 1000;

type UsageRow = {
  semla_session_id: string;
  usage: { cost?: number | null; total?: number | null } | null;
};

/**
 * Totals per Semla session id. Sessions that ran no workflow are absent rather
 * than zero, so a caller can tell "no workflows" from "workflows that cost
 * nothing".
 */
export async function sumWorkflowUsageBySession(
  client: SupabaseClient<Database>,
  sessionIds: readonly string[],
): Promise<Map<string, SessionUsage>> {
  const totals = new Map<string, SessionUsage>();
  if (sessionIds.length === 0) return totals;

  const ids = [...sessionIds];

  // One builder, so the filters cannot drift between pages. No count query:
  // pages are read until one comes back short.
  const page = (index: number) =>
    client
      .from("workflow_runs")
      .select(USAGE_COLUMN)
      .in("semla_session_id", ids)
      .order("id", { ascending: true })
      .range(index * PAGE, index * PAGE + PAGE - 1);

  for (let index = 0; ; index++) {
    const { data, error } = await page(index);
    if (error) throw new Error(error.message);

    for (const row of (data ?? []) as unknown as UsageRow[]) {
      const previous = totals.get(row.semla_session_id) ?? NO_USAGE;
      totals.set(row.semla_session_id, {
        cost: previous.cost + (row.usage?.cost ?? 0),
        tokens: previous.tokens + (row.usage?.total ?? 0),
      });
    }

    if ((data?.length ?? 0) < PAGE) return totals;
  }
}
