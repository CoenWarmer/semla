/**
 * Disk is the primary source for what a session cost. It used to be read out
 * of Postgres, which was both slower — a network round trip against a
 * readFileSync — and behind, because entries are persisted through a queue, so
 * the sidebar trailed a turn that had already finished.
 *
 * Only the conversation half lives here. The workflow half is read from the
 * run files, which `workflow-run-index.ts` maps to a session — a mapping an
 * earlier version of this believed did not exist, having confused "a run file
 * has no session id" with "disk has no index".
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





});

describe("adoptBackfilledUsage", () => {
  it("writes totals recovered from the backup", () => {
    adoptBackfilledUsage(
      SESSION,
      { conversation: { cost: 1, tokens: 10 }, priorRuns: { cost: 2, tokens: 20 } },
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
      { conversation: { cost: 9, tokens: 9 } },
      dir,
    );

    // Disk is the primary source; the backup does not get to correct it.
    expect(readSessionUsage(SESSION, dir)?.conversation.tokens).toBe(500);
  });

});
