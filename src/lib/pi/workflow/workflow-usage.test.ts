/**
 * The same two failures `message-usage.ts` was written against, on a table
 * that is worse on both counts: `snapshot` holds an entire run, and
 * `workflow_runs` had 2,691 rows on the machine this was written on — so a
 * sidebar listing every session would have summed an arbitrary 1,000 of them
 * and called it a total.
 */
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/types/database.types";
import { sumWorkflowUsageBySession } from "./workflow-usage.ts";

type Row = {
  semla_session_id: string;
  usage: { cost?: number | null; total?: number | null } | null;
};

const row = (session: string, total: number, cost = 0): Row => ({
  semla_session_id: session,
  usage: { cost, total },
});

/** Serves `rows` a page at a time exactly as PostgREST would. */
const fakeClient = (rows: Row[], cap = 1000) => {
  const ranges: Array<[number, number]> = [];
  const selects: string[] = [];
  const builder: Record<string, unknown> = {};
  for (const method of ["in", "eq", "filter", "order"]) {
    builder[method] = () => builder;
  }
  builder.select = (columns: string) => {
    selects.push(columns);
    return builder;
  };
  builder.range = (from: number, to: number) => {
    ranges.push([from, to]);
    return Promise.resolve({
      data: rows.slice(from, Math.min(to + 1, from + cap)),
      error: null,
    });
  };

  const client = { from: () => builder } as unknown as SupabaseClient<Database>;
  return { client, ranges, selects };
};

describe("sumWorkflowUsageBySession", () => {
  it("asks for nothing when there are no sessions", async () => {
    const { client, ranges } = fakeClient([]);

    expect(await sumWorkflowUsageBySession(client, [])).toEqual(new Map());
    expect(ranges).toEqual([]);
  });

  it("totals a session's runs", async () => {
    const { client } = fakeClient([
      row("s1", 5_357, 0.02),
      row("s1", 5_366, 0.03),
      row("s2", 100, 0.001),
    ]);

    const totals = await sumWorkflowUsageBySession(client, ["s1", "s2"]);
    expect(totals.get("s1")).toEqual({ cost: 0.05, tokens: 10_723 });
    expect(totals.get("s2")).toEqual({ cost: 0.001, tokens: 100 });
  });

  it("pages past the row cap", async () => {
    const rows = Array.from({ length: 2_691 }, () => row("s1", 10));
    const { client, ranges } = fakeClient(rows);

    const totals = await sumWorkflowUsageBySession(client, ["s1"]);
    // 26,910, not the 10,000 a single capped page would have reported.
    expect(totals.get("s1")?.tokens).toBe(26_910);
    expect(ranges).toHaveLength(3);
  });

  it("stops as soon as a page comes back short", async () => {
    const { client, ranges } = fakeClient([row("s1", 1)]);

    await sumWorkflowUsageBySession(client, ["s1"]);
    // The common case is one round trip; a count query would make it two.
    expect(ranges).toHaveLength(1);
  });

  it("selects only the usage subtree", async () => {
    const { client, selects } = fakeClient([row("s1", 1)]);

    await sumWorkflowUsageBySession(client, ["s1"]);
    // Selecting `snapshot` would ship every agent, prompt and result in the
    // run to add up two numbers.
    expect(selects[0]).toBe("semla_session_id,usage:snapshot->tokenUsage");
  });

  it("leaves out a session that ran no workflow", async () => {
    const { client } = fakeClient([row("s1", 10)]);

    const totals = await sumWorkflowUsageBySession(client, ["s1", "s2"]);
    // Absent, not zero, so a caller can tell "no workflows" from "workflows
    // that cost nothing".
    expect(totals.has("s2")).toBe(false);
  });

  it("treats a run with no usage recorded as nothing", async () => {
    const { client } = fakeClient([
      { semla_session_id: "s1", usage: null },
      { semla_session_id: "s1", usage: { cost: null, total: null } },
      row("s1", 5),
    ]);

    expect(await sumWorkflowUsageBySession(client, ["s1"])).toEqual(
      new Map([["s1", { cost: 0, tokens: 5 }]]),
    );
  });
});
