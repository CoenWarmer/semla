/**
 * The queue's contract is mostly about what it refuses to do: block the writer,
 * throw at the writer, or lose track of a write that arrived while it was busy.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createReindexQueue } from "./reindex-queue";

/** A reindex function whose completion the test controls. */
function deferredReindex() {
  const calls: string[][] = [];
  let release: (() => void) | null = null;
  const reindex = (paths: string[]) => {
    calls.push(paths);
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  return {
    calls,
    reindex,
    finish: () => {
      release?.();
      release = null;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createReindexQueue", () => {
  it("does not index on the write itself", () => {
    const reindex = vi.fn().mockResolvedValue(undefined);
    const queue = createReindexQueue({ reindex, debounceMs: 50 });

    queue.notifyWritten("a.ts");

    // The write returns having done no work: the whole point of the debounce.
    expect(reindex).not.toHaveBeenCalled();
    expect(queue.pending()).toEqual(["a.ts"]);
  });

  it("indexes after the debounce elapses", async () => {
    const reindex = vi.fn().mockResolvedValue(undefined);
    const queue = createReindexQueue({ reindex, debounceMs: 50 });

    queue.notifyWritten("a.ts");
    await vi.advanceTimersByTimeAsync(50);
    await queue.settled();

    expect(reindex).toHaveBeenCalledExactlyOnceWith(["a.ts"]);
    expect(queue.pending()).toEqual([]);
  });

  it("coalesces repeated writes to one path into one request", async () => {
    const reindex = vi.fn().mockResolvedValue(undefined);
    const queue = createReindexQueue({ reindex, debounceMs: 50 });

    // An agent iterating on one file within a turn.
    for (let attempt = 0; attempt < 5; attempt++) queue.notifyWritten("a.ts");
    await vi.advanceTimersByTimeAsync(50);
    await queue.settled();

    expect(reindex).toHaveBeenCalledExactlyOnceWith(["a.ts"]);
  });

  it("batches distinct paths written together", async () => {
    const reindex = vi.fn().mockResolvedValue(undefined);
    const queue = createReindexQueue({ reindex, debounceMs: 50 });

    queue.notifyWritten("b.ts");
    queue.notifyWritten("a.ts");
    await vi.advanceTimersByTimeAsync(50);
    await queue.settled();

    // Sorted, so a run is reproducible.
    expect(reindex).toHaveBeenCalledExactlyOnceWith(["a.ts", "b.ts"]);
  });

  /**
   * The race the single-flight guard exists for. A write landing while a batch
   * is in flight must not join that batch — its upsert has already been
   * composed — and must not be dropped.
   */
  it("picks up a write that arrives mid-flight, in a later batch", async () => {
    const deferred = deferredReindex();
    const queue = createReindexQueue({ reindex: deferred.reindex, debounceMs: 50 });

    queue.notifyWritten("a.ts");
    await vi.advanceTimersByTimeAsync(50);
    expect(deferred.calls).toEqual([["a.ts"]]);

    queue.notifyWritten("b.ts");
    expect(queue.pending()).toEqual(["a.ts", "b.ts"]); // in flight + queued

    deferred.finish();
    await vi.advanceTimersByTimeAsync(0);
    deferred.finish();
    await queue.settled();

    expect(deferred.calls).toEqual([["a.ts"], ["b.ts"]]);
    expect(queue.pending()).toEqual([]);
  });

  it("never throws at the writer when indexing fails", async () => {
    const onError = vi.fn();
    const queue = createReindexQueue({
      reindex: () => Promise.reject(new Error("429 rate limited")),
      debounceMs: 50,
      onError,
    });

    // The edit already succeeded on disk; this must not surface as a failure.
    expect(() => queue.notifyWritten("a.ts")).not.toThrow();
    await vi.advanceTimersByTimeAsync(50);
    await expect(queue.settled()).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledOnce();
    expect(queue.failed()).toEqual(["a.ts"]);
  });

  it("keeps working after a failure", async () => {
    const reindex = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue(undefined);
    const queue = createReindexQueue({ reindex, debounceMs: 50, onError: () => {} });

    queue.notifyWritten("a.ts");
    await vi.advanceTimersByTimeAsync(50);
    await queue.settled();
    expect(queue.failed()).toEqual(["a.ts"]);

    queue.notifyWritten("a.ts");
    await vi.advanceTimersByTimeAsync(50);
    await queue.settled();

    // Retried because it was written again, not because the queue retries
    // forever: the session-start sweep is what catches a path nobody touches.
    expect(queue.failed()).toEqual([]);
    expect(reindex).toHaveBeenCalledTimes(2);
  });

  it("flushes on demand without waiting out the debounce", async () => {
    const reindex = vi.fn().mockResolvedValue(undefined);
    const queue = createReindexQueue({ reindex, debounceMs: 10_000 });

    queue.notifyWritten("a.ts");
    await queue.flush();

    expect(reindex).toHaveBeenCalledExactlyOnceWith(["a.ts"]);
  });

  it("settles immediately when nothing is queued", async () => {
    const queue = createReindexQueue({ reindex: vi.fn(), debounceMs: 50 });
    await expect(queue.settled()).resolves.toBeUndefined();
  });

  it("drops queued work on dispose and releases anyone waiting", async () => {
    const reindex = vi.fn().mockResolvedValue(undefined);
    const queue = createReindexQueue({ reindex, debounceMs: 50 });

    queue.notifyWritten("a.ts");
    const settled = queue.settled();
    queue.dispose();

    await expect(settled).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(100);
    expect(reindex).not.toHaveBeenCalled();
  });
});
