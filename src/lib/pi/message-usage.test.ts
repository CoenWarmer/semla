/**
 * PostgREST returns at most 1,000 rows. Both callers of this sum asked for
 * every assistant message and got a thousand of them, then reported the result
 * as a total — measured against the real database, 67% low: 32.8M tokens where
 * 99.5M had been spent. So the paging is the correctness of this module, not a
 * refinement of it.
 */
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/types/database.types";
import { sumMessageUsageByPiSession } from "./message-usage.ts";

type Row = {
  pi_session_id: string;
  usage: { cost?: { total?: number }; totalTokens?: number } | null;
};

const row = (session: string, tokens: number, cost = 0): Row => ({
  pi_session_id: session,
  usage: { cost: { total: cost }, totalTokens: tokens },
});

/**
 * Stands in for the query builder, serving `rows` a page at a time exactly as
 * PostgREST would — never more than `cap`, however wide the requested range.
 */
const fakeClient = (rows: Row[], cap = 1000) => {
  const ranges: Array<[number, number]> = [];
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "in", "eq", "filter", "order"]) {
    builder[method] = () => builder;
  }
  builder.range = (from: number, to: number) => {
    ranges.push([from, to]);
    const page = rows.slice(from, Math.min(to + 1, from + cap));
    return Promise.resolve({ data: page, error: null });
  };

  const client = { from: () => builder } as unknown as SupabaseClient<Database>;
  return { client, ranges };
};

const sum = (totals: Map<string, { cost: number; tokens: number }>) =>
  [...totals.values()].reduce(
    (acc, usage) => ({
      cost: acc.cost + usage.cost,
      tokens: acc.tokens + usage.tokens,
    }),
    { cost: 0, tokens: 0 },
  );

describe("sumMessageUsageByPiSession", () => {
  it("asks for nothing when there are no sessions", async () => {
    const { client, ranges } = fakeClient([]);

    expect(await sumMessageUsageByPiSession(client, [])).toEqual(new Map());
    expect(ranges).toEqual([]);
  });

  it("totals tokens and cost per session", async () => {
    const { client } = fakeClient([
      row("pi-1", 10, 0.1),
      row("pi-1", 5, 0.05),
      row("pi-2", 7, 0.07),
    ]);

    const totals = await sumMessageUsageByPiSession(client, ["pi-1", "pi-2"]);

    expect(totals.get("pi-1")?.tokens).toBe(15);
    expect(totals.get("pi-1")?.cost).toBeCloseTo(0.15, 10);
    expect(totals.get("pi-2")).toEqual({ cost: 0.07, tokens: 7 });
  });

  /**
   * A session with no assistant messages is absent rather than zero, so a
   * caller can tell "nothing yet" from "nothing spent".
   */
  it("omits a session that has nothing", async () => {
    const { client } = fakeClient([row("pi-1", 10)]);

    const totals = await sumMessageUsageByPiSession(client, ["pi-1", "pi-2"]);

    expect(totals.has("pi-2")).toBe(false);
  });

  it("reads one page when the history fits in one", async () => {
    const { client, ranges } = fakeClient([row("pi-1", 1), row("pi-1", 2)]);

    await sumMessageUsageByPiSession(client, ["pi-1"]);

    expect(ranges).toEqual([[0, 999]]);
  });

  // The bug: 2,163 entries, 1,000 returned, the rest silently dropped.
  it("keeps reading past the row cap until a page comes back short", async () => {
    const rows = Array.from({ length: 2163 }, () => row("pi-1", 1));
    const { client, ranges } = fakeClient(rows);

    const totals = await sumMessageUsageByPiSession(client, ["pi-1"]);

    expect(sum(totals).tokens).toBe(2163);
    expect(ranges).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  /**
   * A history that is an exact multiple of the cap has to be probed once more,
   * or its last full page is indistinguishable from the end.
   */
  it("reads one more page when the last one was exactly full", async () => {
    const rows = Array.from({ length: 2000 }, () => row("pi-1", 1));
    const { client, ranges } = fakeClient(rows);

    const totals = await sumMessageUsageByPiSession(client, ["pi-1"]);

    expect(sum(totals).tokens).toBe(2000);
    expect(ranges).toHaveLength(3);
  });

  it("tolerates an entry with no usage recorded", async () => {
    const { client } = fakeClient([
      { pi_session_id: "pi-1", usage: null },
      { pi_session_id: "pi-1", usage: {} },
      row("pi-1", 4, 0.4),
    ]);

    expect(await sumMessageUsageByPiSession(client, ["pi-1"])).toEqual(
      new Map([["pi-1", { cost: 0.4, tokens: 4 }]]),
    );
  });

  it("surfaces a query failure rather than reporting a short total", async () => {
    const builder: Record<string, unknown> = {};
    for (const method of ["select", "in", "eq", "filter", "order"]) {
      builder[method] = () => builder;
    }
    builder.range = () =>
      Promise.resolve({ data: null, error: { message: "522" } });
    const client = {
      from: () => builder,
    } as unknown as SupabaseClient<Database>;

    await expect(
      sumMessageUsageByPiSession(client, ["pi-1"]),
    ).rejects.toThrow("522");
  });

  it("orders the pages, without which range() may repeat or skip rows", async () => {
    const order = vi.fn();
    const builder: Record<string, unknown> = {};
    for (const method of ["select", "in", "eq", "filter"]) {
      builder[method] = () => builder;
    }
    builder.order = (...args: unknown[]) => {
      order(...args);
      return builder;
    };
    builder.range = () => Promise.resolve({ data: [], error: null });
    const client = {
      from: () => builder,
    } as unknown as SupabaseClient<Database>;

    await sumMessageUsageByPiSession(client, ["pi-1"]);

    expect(order).toHaveBeenCalledWith("id", { ascending: true });
  });
});
