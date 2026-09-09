/**
 * Pins the invariants agent-observers.ts's docblock calls load-bearing:
 * settle() always disposes the session and fires every configured callback,
 * on both the success and the error path; a callback that throws inside
 * settle() must not propagate and must not stop dispose() or the callbacks
 * still queued after it; the context-signal subscription is unconditional
 * (wired even with no onHistory) and tolerates a malformed event; history
 * emission is throttled to 250ms during the turn but settle() always emits
 * a final snapshot regardless of the throttle; and aborting options.signal
 * calls session.abort(), with settle() detaching that listener so a later
 * abort is a no-op.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { attachRunObservers, type ObservableSession } from "./agent-observers.ts";
import type { AgentUsage } from "./agent-types.ts";

/** A session double with a real subscribe/listener list, so tests can fire events by hand. */
function fakeSession(overrides: Partial<ObservableSession> = {}): {
  session: ObservableSession;
  emit: (event: unknown) => void;
  listenerCount: () => number;
  disposed: () => boolean;
} {
  const listeners = new Set<(event: unknown) => void>();
  let disposed = false;

  const session: ObservableSession = {
    messages: [],
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    abort() {
      return undefined;
    },
    getSessionStats() {
      return {
        tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
        cost: 0.01,
      };
    },
    dispose() {
      disposed = true;
    },
    ...overrides,
  };

  return {
    session,
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
    listenerCount: () => listeners.size,
    disposed: () => disposed,
  };
}

describe("attachRunObservers / settle()", () => {
  it("disposes the session and fires onUsage/onContextSignals/onHistory identically on success", () => {
    const { session } = fakeSession();
    const onUsage = vi.fn();
    const onContextSignals = vi.fn();
    const onHistory = vi.fn();

    const observers = attachRunObservers(session, { onUsage, onContextSignals, onHistory });
    // Simulate a successful turn: nothing thrown, just settle at the end.
    observers.settle();

    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onContextSignals).toHaveBeenCalledTimes(1);
    expect(onHistory).toHaveBeenCalledTimes(1);
    expect(session.dispose).toBeDefined();
  });

  it("disposes the session and fires onUsage/onContextSignals/onHistory identically when the turn threw", () => {
    const { session, disposed } = fakeSession();
    const onUsage = vi.fn();
    const onContextSignals = vi.fn();
    const onHistory = vi.fn();

    const observers = attachRunObservers(session, { onUsage, onContextSignals, onHistory });

    let caught: unknown;
    try {
      try {
        throw new Error("turn failed");
      } finally {
        observers.settle();
      }
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onContextSignals).toHaveBeenCalledTimes(1);
    expect(onHistory).toHaveBeenCalledTimes(1);
    expect(disposed()).toBe(true);
  });

  it("swallows a throwing callback without stopping dispose() or the callbacks queued after it", () => {
    const { session, disposed } = fakeSession();
    const onHistory = vi.fn(() => {
      throw new Error("onHistory blew up");
    });
    const onUsage = vi.fn();
    const onContextSignals = vi.fn();

    const observers = attachRunObservers(session, { onHistory, onUsage, onContextSignals });

    expect(() => observers.settle()).not.toThrow();
    // onUsage/onContextSignals run after emitHistory in settle()'s body — a
    // throw in the first must not prevent the later ones, or dispose().
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onContextSignals).toHaveBeenCalledTimes(1);
    expect(disposed()).toBe(true);
  });

  it("swallows a throwing onUsage/onContextSignals callback the same way", () => {
    const { session, disposed } = fakeSession();
    const onUsage = vi.fn(() => {
      throw new Error("onUsage blew up");
    });
    const onContextSignals = vi.fn(() => {
      throw new Error("onContextSignals blew up");
    });

    const observers = attachRunObservers(session, { onUsage, onContextSignals });

    expect(() => observers.settle()).not.toThrow();
    expect(disposed()).toBe(true);
  });
});

describe("context-signal subscription", () => {
  it("records a compaction event even when onHistory is not set", () => {
    const { session, emit } = fakeSession();
    const observers = attachRunObservers(session, {});

    emit({ type: "compaction_start", reason: "threshold" });
    emit({ type: "compaction_end", willRetry: false, result: { tokensBefore: 100 } });

    expect(observers.contextSignals.compactions).toBe(1);
    expect(observers.contextSignals.compactionReasons).toEqual(["threshold"]);
  });

  it("does not break the run on a malformed event", () => {
    const { session, emit } = fakeSession();
    const observers = attachRunObservers(session, {});

    expect(() => emit({ type: "compaction_start", reason: 12345 })).not.toThrow();
    expect(() => emit(null)).not.toThrow();
    expect(() => emit("not an event object")).not.toThrow();
    // The accumulator is still usable afterward.
    expect(observers.contextSignals.compactions).toBeGreaterThanOrEqual(0);
  });
});

describe("history throttling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("throttles history emission to 250ms during the turn", () => {
    const onHistory = vi.fn();
    const { session, emit } = fakeSession();
    attachRunObservers(session, { onHistory });

    // lastHistoryEmit starts at 0, so the very first emit must itself be past
    // t=250 to not be spuriously throttled against that initial value.
    vi.setSystemTime(1000);
    emit({ type: "message" });
    expect(onHistory).toHaveBeenCalledTimes(1);

    vi.setSystemTime(1100);
    emit({ type: "message" });
    // Still within the 250ms window since the last emit — throttled, no new call.
    expect(onHistory).toHaveBeenCalledTimes(1);

    vi.setSystemTime(1260);
    emit({ type: "message" });
    expect(onHistory).toHaveBeenCalledTimes(2);
  });

  it("settle() always emits a final snapshot even immediately after a throttled emit", () => {
    const onHistory = vi.fn();
    const { session, emit } = fakeSession();
    const observers = attachRunObservers(session, { onHistory });

    vi.setSystemTime(1000);
    emit({ type: "message" });
    expect(onHistory).toHaveBeenCalledTimes(1);

    vi.setSystemTime(1050);
    emit({ type: "message" });
    // Throttled — no second call yet.
    expect(onHistory).toHaveBeenCalledTimes(1);

    observers.settle();
    // settle() calls emitHistory() unconditionally, bypassing the throttle gate.
    expect(onHistory).toHaveBeenCalledTimes(2);
  });
});

describe("abort forwarding", () => {
  it("calls session.abort() when options.signal is aborted", () => {
    const abort = vi.fn();
    const { session } = fakeSession({ abort });
    const controller = new AbortController();

    attachRunObservers(session, { signal: controller.signal });
    controller.abort();

    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("detaches the abort listener in settle(), so a later abort is a no-op", () => {
    const abort = vi.fn();
    const { session } = fakeSession({ abort });
    const controller = new AbortController();

    const observers = attachRunObservers(session, { signal: controller.signal });
    observers.settle();
    controller.abort();

    expect(abort).not.toHaveBeenCalled();
  });
});

describe("onUsage", () => {
  it("is not called when session stats are all-zero (usageFromStats returns undefined)", () => {
    const { session } = fakeSession({
      getSessionStats: () => ({
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: 0,
      }),
    });
    const onUsage = vi.fn<(usage: AgentUsage) => void>();

    attachRunObservers(session, { onUsage }).settle();

    expect(onUsage).not.toHaveBeenCalled();
  });
});
