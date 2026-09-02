/**
 * Token and cost totals summed from a session's assistant messages.
 *
 * Two callers wanted this and each rolled its own, which is how they came to
 * disagree about how much it costs and to share a bug neither noticed.
 *
 * The expensive mistake is selecting `payload`. That column holds the whole pi
 * entry — message text, tool results, the lot — so summing usage in JS
 * transferred every byte of it: the sidebar was pulling 3.6 MB on a root-layout
 * render, most of it from rows it discarded on arrival. Postgres extracts the
 * usage subtree and applies the role filter instead, which for the same data is
 * 2,163 rows rather than 4,883, and a fraction of the bytes.
 *
 * The quiet bug is the row cap. PostgREST returns at most 1,000 rows, so both
 * callers were summing 1,000 of 2,163 assistant entries and reporting the
 * result as a total — and with no ordering, an arbitrary 1,000. Paging is
 * therefore not an optimisation here, it is the difference between a number and
 * a guess, and the pages are ordered because `range()` without an order may
 * repeat or skip rows.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/types/database.types";

export type MessageUsage = { cost: number; tokens: number };

/** Only the usage subtree, named so the row reads as `{ usage }`. */
const USAGE_COLUMN = "pi_session_id,usage:payload->entry->message->usage";
const ROLE_PATH = "payload->entry->message->>role";

/** PostgREST's default `max-rows`. Asking for more returns this many. */
const PAGE = 1000;

type UsageRow = {
  pi_session_id: string;
  usage: { cost?: { total?: number } | null; totalTokens?: number } | null;
};

const EMPTY: MessageUsage = { cost: 0, tokens: 0 };

/**
 * Totals per `pi_session_id`. Sessions with no assistant messages are absent
 * rather than zero, so a caller can tell "nothing yet" from "nothing spent".
 */
export async function sumMessageUsageByPiSession(
  client: SupabaseClient<Database>,
  piSessionIds: readonly string[],
): Promise<Map<string, MessageUsage>> {
  const totals = new Map<string, MessageUsage>();
  if (piSessionIds.length === 0) return totals;

  const ids = [...piSessionIds];

  // One builder, so the filters cannot drift between a count and a page — and
  // no count query at all: pages are read until one comes back short, which
  // for the overwhelmingly common case of a history under `PAGE` assistant
  // messages is a single round trip.
  const page = (index: number) =>
    client
      .from("pi_session_entries")
      .select(USAGE_COLUMN)
      .in("pi_session_id", ids)
      .eq("event_type", "message")
      .filter(ROLE_PATH, "eq", "assistant")
      .order("id", { ascending: true })
      .range(index * PAGE, index * PAGE + PAGE - 1);

  for (let index = 0; ; index++) {
    const { data, error } = await page(index);
    if (error) throw new Error(error.message);

    for (const row of (data ?? []) as unknown as UsageRow[]) {
      const previous = totals.get(row.pi_session_id) ?? EMPTY;
      totals.set(row.pi_session_id, {
        cost: previous.cost + (row.usage?.cost?.total ?? 0),
        tokens: previous.tokens + (row.usage?.totalTokens ?? 0),
      });
    }

    if ((data?.length ?? 0) < PAGE) return totals;
  }
}
