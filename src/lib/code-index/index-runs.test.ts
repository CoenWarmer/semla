/**
 * The run registry: one run per project, progress pushed to subscribers, and a
 * failure that lands on the run rather than on the process.
 *
 * That last one is the reason this file exists. Nothing awaits the promise the
 * work runs on, so an error escaping it is an unhandled rejection — which takes
 * down the server rather than failing the index.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveEmbedder = vi.fn();
vi.mock("./credentials", () => ({ resolveEmbedder: () => resolveEmbedder() }));

const {
  clearIndexRuns,
  getIndexRun,
  isIndexRunning,
  startIndexRun,
  subscribeToIndexRuns,
} = await import("./index-runs");

let root: string;
let indexHome: string;

/**
 * An embedder whose completion the test controls.
 *
 * Latched, not a bare deferred: `finish()` is usually called before the ingest
 * has finished scanning and chunking, so a naive helper drops the release on
 * the floor and the run never completes.
 */
function pausedEmbedder() {
  let release: (() => void) | null = null;
  let released = false;
  return {
    model: "fake/model",
    dim: 2,
    embed: (texts: readonly string[]) =>
      new Promise<Float32Array[]>((resolve) => {
        const settle = () => resolve(texts.map(() => new Float32Array([1, 0])));
        if (released) settle();
        else release = settle;
      }),
    finish: () => {
      released = true;
      release?.();
    },
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "semla-runs-"));
  indexHome = mkdtempSync(join(tmpdir(), "semla-runs-home-"));
  process.env.SEMLA_INDEX_HOME = indexHome;
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/a.ts"), "export function alpha() {\n  return 1;\n}\n");
  clearIndexRuns();
  resolveEmbedder.mockReset();
});

afterEach(() => {
  clearIndexRuns();
  rmSync(root, { recursive: true, force: true });
  rmSync(indexHome, { recursive: true, force: true });
  delete process.env.SEMLA_INDEX_HOME;
});

/** Wait for the registry to mark the run finished. */
async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (getIndexRun(root)?.finishedAt !== null) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("startIndexRun", () => {
  it("returns immediately rather than awaiting the ingest", () => {
    const embedder = pausedEmbedder();
    resolveEmbedder.mockReturnValue(embedder);

    const run = startIndexRun(root);

    // The embedding has not resolved, and the call already returned.
    expect(run.finishedAt).toBeNull();
    expect(isIndexRunning(root)).toBe(true);
    embedder.finish();
  });

  it("completes and records a report", async () => {
    const embedder = pausedEmbedder();
    resolveEmbedder.mockReturnValue(embedder);

    startIndexRun(root);
    embedder.finish();
    await settle();

    const run = getIndexRun(root)!;
    expect(run.error).toBeNull();
    expect(run.report?.changed).toBe(true);
    expect(isIndexRunning(root)).toBe(false);
  });

  /**
   * Two runs over one project would diff against the same stored manifest,
   * embed the same files and race each other's upserts — a correct index
   * reached by luck, paid for twice.
   */
  it("does not start a second run for a project already running", () => {
    const embedder = pausedEmbedder();
    resolveEmbedder.mockReturnValue(embedder);

    const first = startIndexRun(root);
    const second = startIndexRun(root);

    expect(second).toBe(first);
    embedder.finish();
  });

  it("allows a new run once the previous one finished", async () => {
    const first = pausedEmbedder();
    resolveEmbedder.mockReturnValue(first);
    const one = startIndexRun(root);
    first.finish();
    await settle();

    const second = pausedEmbedder();
    resolveEmbedder.mockReturnValue(second);
    const two = startIndexRun(root);

    expect(two).not.toBe(one);
    second.finish();
    await settle();
  });

  it("reports a missing credential on the run instead of throwing", () => {
    resolveEmbedder.mockReturnValue(null);

    const run = startIndexRun(root);

    expect(run.error).toMatch(/no embedding credential/i);
    expect(run.finishedAt).not.toBeNull();
  });

  it("records an ingest failure on the run rather than rejecting", async () => {
    resolveEmbedder.mockReturnValue({
      model: "fake/model",
      dim: 2,
      embed: () => Promise.reject(new Error("429 rate limited")),
    });

    startIndexRun(root);
    await settle();

    // Not an unhandled rejection: nothing awaits the run's promise, so an
    // escaping error would take down the server.
    expect(getIndexRun(root)?.error).toMatch(/429/);
    expect(isIndexRunning(root)).toBe(false);
  });

  it("accumulates usage reported by the embedder", async () => {
    resolveEmbedder.mockImplementation(() => ({
      model: "fake/model",
      dim: 2,
      embed: (texts: readonly string[]) =>
        Promise.resolve(texts.map(() => new Float32Array([1, 0]))),
    }));

    startIndexRun(root);
    await settle();

    // The embedder here reports none, so the totals stay at zero rather than
    // being invented.
    expect(getIndexRun(root)?.tokens).toBe(0);
  });
});

describe("subscribeToIndexRuns", () => {
  it("pushes progress as the run advances", async () => {
    const embedder = pausedEmbedder();
    resolveEmbedder.mockReturnValue(embedder);

    const seen: string[] = [];
    subscribeToIndexRuns((run) => seen.push(run.progress.phase));

    startIndexRun(root);
    embedder.finish();
    await settle();

    expect(seen).toContain("scanning");
    expect(seen.length).toBeGreaterThan(1);
  });

  it("replays current runs to a subscriber that joins late", async () => {
    const embedder = pausedEmbedder();
    resolveEmbedder.mockReturnValue(embedder);
    startIndexRun(root);

    // A client connecting mid-ingest should see where it is, not wait for the
    // next tick.
    const seen: unknown[] = [];
    subscribeToIndexRuns((run) => seen.push(run));
    expect(seen).toHaveLength(1);

    embedder.finish();
    await settle();
  });

  it("stops delivering after unsubscribe", async () => {
    const embedder = pausedEmbedder();
    resolveEmbedder.mockReturnValue(embedder);

    let count = 0;
    const { unsubscribe } = subscribeToIndexRuns(() => count++);
    unsubscribe();

    startIndexRun(root);
    embedder.finish();
    await settle();

    expect(count).toBe(0);
  });

  it("survives a subscriber that throws", async () => {
    const embedder = pausedEmbedder();
    resolveEmbedder.mockReturnValue(embedder);

    subscribeToIndexRuns(() => {
      throw new Error("closed stream");
    });
    let delivered = 0;
    subscribeToIndexRuns(() => delivered++);

    startIndexRun(root);
    embedder.finish();
    await settle();

    // A dead SSE connection must not fail the index for everyone else.
    expect(delivered).toBeGreaterThan(0);
    expect(getIndexRun(root)?.error).toBeNull();
  });
});
