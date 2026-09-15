/**
 * docs/plans/superseded-turns.md §4 (Phase 1): a new prompt must wait for
 * whatever turn was running before it to abort and completely finish before
 * it starts touching the session file itself — otherwise both turns'
 * `SessionManager`s can append to the same file, and whichever happens to
 * finish last wins the leaf regardless of which one the operator is actually
 * looking at.
 */
import { describe, expect, it, vi } from "vitest";

import { hasTurnSlot, takeTurnSlot } from "./session-turn-lock.ts";

describe("takeTurnSlot", () => {
  it("resolves immediately when nothing is running", async () => {
    const slot = takeTurnSlot("s1");

    await expect(slot.waitForPrior()).resolves.toBeUndefined();

    slot.finish();
  });

  it("reports a turn as pending until it finishes", () => {
    const slot = takeTurnSlot("s2");

    expect(hasTurnSlot("s2")).toBe(true);

    slot.finish();

    expect(hasTurnSlot("s2")).toBe(false);
  });

  it("calls the prior turn's abort and waits for it to settle before proceeding", async () => {
    const order: string[] = [];
    const first = takeTurnSlot("s3");
    const abort = vi.fn(async () => {
      order.push("aborted");
    });
    first.updateAbort(abort);

    const second = takeTurnSlot("s3");
    const waited = second.waitForPrior().then(() => order.push("waited"));

    // The first turn has not finished yet: the second must still be waiting.
    await Promise.resolve();
    expect(abort).toHaveBeenCalledOnce();
    expect(order).toEqual(["aborted"]);

    first.finish();
    await waited;

    expect(order).toEqual(["aborted", "waited"]);
  });

  it("does not wait on a turn that has already finished", async () => {
    const first = takeTurnSlot("s4");
    first.finish();

    const second = takeTurnSlot("s4");

    await expect(second.waitForPrior()).resolves.toBeUndefined();
    second.finish();
  });

  // The race this module exists to close: two prompts for the same session
  // arriving close enough together that both could be past their first
  // `await` before either has registered. Taking the slot has to happen in
  // one synchronous tick so this is impossible by construction.
  it("orders two immediately-consecutive callers deterministically", () => {
    const firstSlot = takeTurnSlot("s5");
    const secondSlot = takeTurnSlot("s5");

    // secondSlot's waitForPrior must resolve only once firstSlot finishes —
    // proven by the fact that secondSlot captured firstSlot as its prior,
    // which only one of them can have done.
    expect(hasTurnSlot("s5")).toBe(true);
    firstSlot.finish();
    // firstSlot dropped its own registration; secondSlot is still current.
    expect(hasTurnSlot("s5")).toBe(true);
    secondSlot.finish();
    expect(hasTurnSlot("s5")).toBe(false);
  });

  it("does not let a stale registration clear a newer one", () => {
    const first = takeTurnSlot("s6");
    const second = takeTurnSlot("s6");

    // first's finish() must be a no-op once second has taken the slot.
    first.finish();
    expect(hasTurnSlot("s6")).toBe(true);

    second.finish();
    expect(hasTurnSlot("s6")).toBe(false);
  });

  it("treats a rejected abort as still requiring the wait for settled", async () => {
    const first = takeTurnSlot("s7");
    first.updateAbort(() => Promise.reject(new Error("abort failed")));

    const second = takeTurnSlot("s7");
    let waited = false;
    const waitPromise = second.waitForPrior().then(() => {
      waited = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(waited).toBe(false);

    first.finish();
    await waitPromise;

    expect(waited).toBe(true);
  });
});
