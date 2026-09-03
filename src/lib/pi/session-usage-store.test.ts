/**
 * Disk is the primary source for what a session cost. It used to be read out
 * of Postgres, which was both slower — a network round trip against a
 * readFileSync — and behind, because entries are persisted through a queue, so
 * the sidebar trailed a turn that had already finished.
 *
 * The stamp cannot be replaced by a later sweep: a workflow run file records
 * its own tokenUsage but *not* the session that started it, so nothing on disk
 * maps runs to sessions. The turn is the only place that mapping exists.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { writeSessionMeta } from "@/lib/pi/session-meta";
import {
  adoptBackfilledUsage,
  readSessionUsage,
  stampConversationUsage,
  stampRunUsage,
  sumEntryUsage,
} from "@/lib/pi/session-usage-store";
import { sessionUsageTotal } from "@/lib/session-usage";

const SESSION = "00000000-0000-4000-8000-0000000005e1";

let dir: string;

beforeEach(async () => {
  // Always injected. Defaulting to PI_SESSION_DIR once wrote 201 junk
  // sessions into the real directory.
  dir = await mkdtemp(join(tmpdir(), "semla-usage-"));
  writeSessionMeta(SESSION, { title: "t" }, dir);
});

const entry = (role: string, tokens: number, cost = 0) => ({
  message: { role, usage: { cost: { total: cost }, totalTokens: tokens } },
});

describe("sumEntryUsage", () => {
  it("sums the assistant's messages", () => {
    expect(
      sumEntryUsage([entry("assistant", 100, 0.01), entry("assistant", 50, 0.02)]),
    ).toEqual({ cost: 0.03, tokens: 150 });
  });

  it("ignores other roles", () => {
    // A user entry carries no usage today, and counting a role that later
    // gains one would double the bill.
    expect(sumEntryUsage([entry("user", 999, 9), entry("assistant", 1, 0)])).toEqual(
      { cost: 0, tokens: 1 },
    );
  });

  it("tolerates entries with nothing to add", () => {
    expect(sumEntryUsage([{}, { message: null }, { message: { role: "assistant" } }]))
      .toEqual({ cost: 0, tokens: 0 });
    expect(sumEntryUsage([])).toEqual({ cost: 0, tokens: 0 });
  });
});

describe("stamping", () => {
  it("records the conversation half", () => {
    stampConversationUsage(SESSION, { cost: 0.03, tokens: 150 }, dir);

    expect(readSessionUsage(SESSION, dir)?.conversation).toEqual({
      cost: 0.03,
      tokens: 150,
    });
  });

  it("replaces the conversation half rather than adding to it", () => {
    // The entries are cumulative for the session, so each turn stamps a total.
    stampConversationUsage(SESSION, { cost: 0.01, tokens: 100 }, dir);
    stampConversationUsage(SESSION, { cost: 0.03, tokens: 300 }, dir);

    expect(readSessionUsage(SESSION, dir)?.conversation.tokens).toBe(300);
  });

  it("keys a run by its id, so repeated snapshots count once", () => {
    // A run's snapshot is persisted many times as it progresses.
    stampRunUsage(SESSION, "run-1", { cost: 0.01, tokens: 100 }, dir);
    stampRunUsage(SESSION, "run-1", { cost: 0.02, tokens: 5_000 }, dir);
    stampRunUsage(SESSION, "run-1", { cost: 0.03, tokens: 10_723 }, dir);

    const record = readSessionUsage(SESSION, dir);
    expect(Object.keys(record?.runs ?? {})).toEqual(["run-1"]);
    expect(record?.runs["run-1"]?.tokens).toBe(10_723);
  });

  it("keeps concurrent runs apart", () => {
    stampRunUsage(SESSION, "run-1", { cost: 0.02, tokens: 5_357 }, dir);
    stampRunUsage(SESSION, "run-2", { cost: 0.03, tokens: 5_366 }, dir);

    expect(sessionUsageTotal(readSessionUsage(SESSION, dir) ?? undefined)).toEqual({
      cost: 0.05,
      tokens: 10_723,
    });
  });

  it("totals both halves", () => {
    stampConversationUsage(SESSION, { cost: 0.0344, tokens: 1_045 }, dir);
    stampRunUsage(SESSION, "run-1", { cost: 0.05, tokens: 10_723 }, dir);

    // The real split from the session that exposed the bug.
    expect(sessionUsageTotal(readSessionUsage(SESSION, dir) ?? undefined)).toEqual({
      cost: 0.0844,
      tokens: 11_768,
    });
  });

  it("does not resurrect a session that does not exist", () => {
    stampRunUsage("00000000-0000-4000-8000-00000000dead", "r", { cost: 1, tokens: 1 }, dir);

    expect(readSessionUsage("00000000-0000-4000-8000-00000000dead", dir)).toBeNull();
  });

  it("leaves the rest of the meta intact", () => {
    stampRunUsage(SESSION, "run-1", { cost: 0, tokens: 10 }, dir);
    stampConversationUsage(SESSION, { cost: 0, tokens: 5 }, dir);

    // writeSessionMeta merges, but a stamp that clobbered the title would be
    // a session losing its name to a token count.
    const record = readSessionUsage(SESSION, dir);
    expect(record?.runs["run-1"]?.tokens).toBe(10);
    expect(record?.conversation.tokens).toBe(5);
  });
});

describe("adoptBackfilledUsage", () => {
  it("writes totals recovered from the backup", () => {
    adoptBackfilledUsage(
      SESSION,
      { conversation: { cost: 1, tokens: 10 }, priorRuns: { cost: 2, tokens: 20 }, runs: {} },
      dir,
    );

    expect(sessionUsageTotal(readSessionUsage(SESSION, dir) ?? undefined)).toEqual({
      cost: 3,
      tokens: 30,
    });
  });

  it("never overwrites what disk already knows", () => {
    stampConversationUsage(SESSION, { cost: 0.5, tokens: 500 }, dir);
    adoptBackfilledUsage(
      SESSION,
      { conversation: { cost: 9, tokens: 9 }, runs: {} },
      dir,
    );

    // Disk is the primary source; the backup does not get to correct it.
    expect(readSessionUsage(SESSION, dir)?.conversation.tokens).toBe(500);
  });

  it("adds a later run on top of backfilled runs", () => {
    adoptBackfilledUsage(
      SESSION,
      { conversation: { cost: 0, tokens: 100 }, priorRuns: { cost: 0, tokens: 900 }, runs: {} },
      dir,
    );
    stampRunUsage(SESSION, "new-run", { cost: 0, tokens: 50 }, dir);

    // priorRuns is not a run id, so a new run cannot collide with it, and the
    // finished ones will never be stamped again.
    expect(sessionUsageTotal(readSessionUsage(SESSION, dir) ?? undefined).tokens).toBe(
      1_050,
    );
  });
});
