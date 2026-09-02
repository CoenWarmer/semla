/**
 * The turn used to write every entry of the whole conversation on every turn,
 * one round trip at a time, before telling the client it was done. A ten-turn
 * session in .semla-debug spent 337 seconds across 3,009 such writes — 133 of
 * them in its last turn — re-storing rows that had not changed.
 *
 * So the two properties that matter here are: an entry already stored is never
 * written again, and queueing does not make the caller wait.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { persistEntries } = vi.hoisted(() => ({
  persistEntries: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/pi/session-persistence", () => ({ persistEntries }));

import {
  flushEntryQueue,
  pendingEntryCount,
  queueEntries,
  seedPersistedEntryIds,
} from "./entry-persist-queue.ts";

const entry = (id: string) => ({
  id,
  parentId: null,
  timestamp: "2026-09-02T13:00:00.000Z",
  type: "message",
});

const entries = (...ids: string[]) => ids.map(entry);

/** The ids each call to persistEntries was given, in order. */
const written = () =>
  persistEntries.mock.calls.map((call) =>
    ((call as unknown as [string, { id: string }[]])[1] ?? []).map((e) => e.id),
  );

const PI = "pi-session-1";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  await flushEntryQueue(PI);
});

describe("queueEntries", () => {
  it("writes the entries a turn produced", async () => {
    expect(queueEntries(PI, "s1", entries("a", "b"))).toBe(2);
    await flushEntryQueue(PI);

    expect(written()).toEqual([["a", "b"]]);
  });

  /**
   * The whole point. The turn hands over every entry in the conversation; only
   * the ones the mirror does not already hold should cost anything.
   */
  it("skips entries the mirror already holds", async () => {
    seedPersistedEntryIds(PI, ["a", "b"]);

    expect(queueEntries(PI, "s1", entries("a", "b", "c"))).toBe(1);
    await flushEntryQueue(PI);

    expect(written()).toEqual([["c"]]);
  });

  it("writes nothing at all for a turn that added nothing", async () => {
    seedPersistedEntryIds(PI, ["a", "b"]);

    expect(queueEntries(PI, "s1", entries("a", "b"))).toBe(0);
    await flushEntryQueue(PI);

    expect(persistEntries).not.toHaveBeenCalled();
  });

  /**
   * The turn after, as runPiPrompt does it: the conversation is handed over in
   * full, having first seeded what the database reported.
   */
  it("writes only what a later turn added", async () => {
    queueEntries(PI, "s1", entries("a", "b"));
    await flushEntryQueue(PI);
    vi.clearAllMocks();

    seedPersistedEntryIds(PI, ["a", "b"]);
    expect(queueEntries(PI, "s1", entries("a", "b", "c", "d"))).toBe(2);
    await flushEntryQueue(PI);

    expect(written()).toEqual([["c", "d"]]);
  });

  /**
   * A turn that starts while the previous drain is still in flight has not had
   * those ids reported to it by the database yet, so the queue has to remember
   * them itself.
   */
  it("does not rewrite entries still in flight", async () => {
    let release: (() => void) | undefined;
    persistEntries.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = resolve)),
    );

    queueEntries(PI, "s1", entries("a", "b"));
    // Next turn arrives; the database cannot see a or b yet.
    seedPersistedEntryIds(PI, []);
    expect(queueEntries(PI, "s1", entries("a", "b", "c"))).toBe(1);

    release?.();
    await flushEntryQueue(PI);

    expect(written().flat()).toEqual(["a", "b", "c"]);
  });

  it("de-duplicates within a single call", async () => {
    expect(queueEntries(PI, "s1", entries("a", "a", "b"))).toBe(2);
    await flushEntryQueue(PI);

    expect(written()).toEqual([["a", "b"]]);
  });

  /**
   * The reason this is a queue and not an await: the answer has already
   * streamed and the session file is already written, so the turn must be able
   * to tell the client it is done without waiting for Postgres.
   */
  it("returns without waiting for the write to finish", async () => {
    let release: (() => void) | undefined;
    let settled = false;
    persistEntries.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            settled = true;
            resolve();
          };
        }),
    );

    // Synchronous: no await, and the write is still outstanding on return.
    expect(queueEntries(PI, "s1", entries("a"))).toBe(1);
    expect(settled).toBe(false);

    release?.();
    await flushEntryQueue(PI);
    expect(settled).toBe(true);
  });

  // A batch bigger than one drain iteration still leaves nothing behind.
  it("leaves nothing pending once quiet", async () => {
    queueEntries(PI, "s1", entries("a", "b", "c"));
    await flushEntryQueue(PI);

    expect(pendingEntryCount(PI)).toBe(0);
  });

  /**
   * Entries carry a self-referencing parent_entry_id, so two overlapping
   * drains could offer a child before its parent.
   */
  it("does not start a second drain while one is running", async () => {
    let release: (() => void) | undefined;
    persistEntries.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = resolve)),
    );

    queueEntries(PI, "s1", entries("a"));
    queueEntries(PI, "s1", entries("b"));
    expect(persistEntries).toHaveBeenCalledTimes(1);

    release?.();
    await flushEntryQueue(PI);

    expect(written()).toEqual([["a"], ["b"]]);
  });
});

describe("when the mirror is unreachable", () => {
  /**
   * The session file still holds every entry, so a failed write leaves the
   * mirror a turn behind rather than losing the conversation. Forgetting the
   * ids is what lets the next turn try again.
   */
  it("retries the entries on the next turn", async () => {
    persistEntries.mockRejectedValueOnce(new Error("522"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    queueEntries(PI, "s1", entries("a", "b"));
    await flushEntryQueue(PI);
    expect(warn).toHaveBeenCalled();

    persistEntries.mockClear();
    expect(queueEntries(PI, "s1", entries("a", "b"))).toBe(2);
    await flushEntryQueue(PI);

    expect(written()).toEqual([["a", "b"]]);
    warn.mockRestore();
  });

  it("does not throw at the caller", () => {
    persistEntries.mockRejectedValueOnce(new Error("522"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => queueEntries(PI, "s1", entries("a"))).not.toThrow();

    warn.mockRestore();
  });
});

describe("seedPersistedEntryIds", () => {
  /**
   * A previous turn's drain may still be in flight, so its ids are not in what
   * the database reports yet. Replacing rather than adding would write them a
   * second time.
   */
  it("adds to what is known rather than replacing it", async () => {
    queueEntries(PI, "s1", entries("a"));
    seedPersistedEntryIds(PI, ["b"]);

    expect(queueEntries(PI, "s1", entries("a", "b", "c"))).toBe(1);
    await flushEntryQueue(PI);

    expect(written().flat()).toEqual(["a", "c"]);
  });
});
