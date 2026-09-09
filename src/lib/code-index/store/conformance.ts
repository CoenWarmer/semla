/**
 * One behavioural contract, run against every VectorStore backend.
 *
 * This exists because the two backends will otherwise drift, and the drift does
 * not announce itself: a `deleteByPath` that leaves orphans, or a ranking that
 * breaks ties differently, produces worse answers rather than errors. Anything
 * a caller may rely on belongs here rather than in a backend's own test file,
 * so that adding the pgvector backend means running this suite, not reading the
 * local one and reimplementing its assumptions.
 *
 * Not a `.test.ts` file: vitest collects those, and this is a helper the
 * backends' own test files call.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EmbeddedChunk, ProjectKey } from "../types";
import type { VectorStore } from "./types";

/** A unit vector pointing along one axis, so similarities are exact. */
export function axisVector(axis: number, dim = 4): Float32Array {
  const vector = new Float32Array(dim);
  vector[axis] = 1;
  return vector;
}

export function chunkAt(
  path: string,
  startLine: number,
  vector: Float32Array,
  overrides: Partial<EmbeddedChunk> = {},
): EmbeddedChunk {
  return {
    path,
    startLine,
    endLine: startLine + 10,
    hash: `hash-${path}-${startLine}`,
    fileHash: `file-${path}`,
    strategy: "ast",
    kind: "source",
    vector,
    ...overrides,
  };
}

export interface StoreHarness {
  store: VectorStore;
  /** Called before each test; returns the project key under test. */
  setup: () => Promise<ProjectKey> | ProjectKey;
  /** Called after each test to remove whatever setup created. */
  teardown?: () => Promise<void> | void;
}

export function describeVectorStore(
  label: string,
  createHarness: () => StoreHarness,
): void {
  describe(`VectorStore contract: ${label}`, () => {
    let harness: StoreHarness;
    let store: VectorStore;
    let project: ProjectKey;

    beforeEach(async () => {
      harness = createHarness();
      store = harness.store;
      project = await harness.setup();
    });

    afterEach(async () => {
      await harness.teardown?.();
    });

    it("reports no head for a project that was never indexed", async () => {
      expect(await store.head(project)).toBeNull();
      expect(await store.query(project, axisVector(0), 5)).toEqual([]);
      expect(await store.manifest(project)).toEqual({});
    });

    it("ranks by cosine similarity, nearest first", async () => {
      await store.upsert(project, [
        chunkAt("a.ts", 1, axisVector(0)),
        chunkAt("b.ts", 1, axisVector(1)),
        chunkAt("c.ts", 1, axisVector(2)),
      ]);

      const hits = await store.query(project, axisVector(1), 3);
      expect(hits.map((hit) => hit.path)).toEqual(["b.ts", "a.ts", "c.ts"]);
      expect(hits[0].score).toBeCloseTo(1, 5);
      expect(hits[1].score).toBeCloseTo(0, 5);
    });

    it("honours k", async () => {
      await store.upsert(project, [
        chunkAt("a.ts", 1, axisVector(0)),
        chunkAt("b.ts", 1, axisVector(1)),
      ]);
      expect(await store.query(project, axisVector(0), 1)).toHaveLength(1);
    });

    it("returns citations, never source text", async () => {
      await store.upsert(project, [
        chunkAt("src/a.ts", 40, axisVector(0), { endLine: 88, symbol: "run" }),
      ]);
      const [hit] = await store.query(project, axisVector(0), 1);

      expect(hit).toMatchObject({
        path: "src/a.ts",
        startLine: 40,
        endLine: 88,
        symbol: "run",
      });
      // The absence is the contract: text is read from disk at query time, so
      // an index cannot serve code that the file no longer contains.
      expect(hit).not.toHaveProperty("text");
      expect(hit).not.toHaveProperty("content");
    });

    it("replaces every chunk of a path on re-upsert, leaving no orphans", async () => {
      await store.upsert(project, [
        chunkAt("a.ts", 1, axisVector(0)),
        chunkAt("a.ts", 20, axisVector(0)),
        chunkAt("b.ts", 1, axisVector(1)),
      ]);

      // The file was edited: one chunk now, at a different line range.
      await store.upsert(project, [
        chunkAt("a.ts", 5, axisVector(0), { fileHash: "file-a-v2" }),
      ]);

      const hits = await store.query(project, axisVector(0), 10);
      const fromA = hits.filter((hit) => hit.path === "a.ts");
      expect(fromA).toHaveLength(1);
      expect(fromA[0].startLine).toBe(5);
      // The untouched file survived.
      expect(hits.some((hit) => hit.path === "b.ts")).toBe(true);
    });

    it("deletes every chunk of a path", async () => {
      await store.upsert(project, [
        chunkAt("a.ts", 1, axisVector(0)),
        chunkAt("a.ts", 20, axisVector(0)),
        chunkAt("b.ts", 1, axisVector(1)),
      ]);
      await store.deleteByPath(project, ["a.ts"]);

      const hits = await store.query(project, axisVector(0), 10);
      expect(hits.map((hit) => hit.path)).toEqual(["b.ts"]);
    });

    it("derives the manifest from the stored rows", async () => {
      await store.upsert(project, [
        chunkAt("a.ts", 1, axisVector(0), { fileHash: "aaa" }),
        chunkAt("a.ts", 20, axisVector(0), { fileHash: "aaa" }),
        chunkAt("b.ts", 1, axisVector(1), { fileHash: "bbb" }),
      ]);
      expect(await store.manifest(project)).toEqual({ "a.ts": "aaa", "b.ts": "bbb" });

      await store.deleteByPath(project, ["a.ts"]);
      expect(await store.manifest(project)).toEqual({ "b.ts": "bbb" });
    });

    it("stamps a head whose chunk count matches the rows", async () => {
      await store.upsert(project, [
        chunkAt("a.ts", 1, axisVector(0)),
        chunkAt("b.ts", 1, axisVector(1)),
      ]);
      await store.putHead(project, {
        root: "/repo",
        model: "openai/text-embedding-3-small",
        dim: 4,
        merkleRoot: "root-1",
        updated: "2026-09-09T00:00:00.000Z",
      });

      const head = await store.head(project);
      expect(head).toMatchObject({ version: 1, dim: 4, merkleRoot: "root-1", chunks: 2 });
    });

    it("keeps the head's count honest after rows are deleted", async () => {
      await store.upsert(project, [
        chunkAt("a.ts", 1, axisVector(0)),
        chunkAt("b.ts", 1, axisVector(1)),
      ]);
      await store.putHead(project, {
        root: "/repo",
        model: "m",
        dim: 4,
        merkleRoot: "root-1",
        updated: "2026-09-09T00:00:00.000Z",
      });
      await store.deleteByPath(project, ["a.ts"]);

      expect((await store.head(project))?.chunks).toBe(1);
    });

    it("refuses a query whose dimension disagrees with the index", async () => {
      await store.upsert(project, [chunkAt("a.ts", 1, axisVector(0))]);
      await store.putHead(project, {
        root: "/repo",
        model: "m",
        dim: 4,
        merkleRoot: "root-1",
        updated: "2026-09-09T00:00:00.000Z",
      });

      // Silently comparing vectors from two models returns confidently ranked
      // garbage with no error anywhere. It has to be loud.
      await expect(store.query(project, new Float32Array(8), 3)).rejects.toThrow(
        /dimension/i,
      );
    });

    it("refuses to mix dimensions on upsert", async () => {
      await store.upsert(project, [chunkAt("a.ts", 1, axisVector(0))]);
      await expect(
        store.upsert(project, [chunkAt("b.ts", 1, new Float32Array(8))]),
      ).rejects.toThrow(/dimension/i);
    });

    it("drops the index, and drop is idempotent", async () => {
      await store.upsert(project, [chunkAt("a.ts", 1, axisVector(0))]);
      await store.drop(project);
      await store.drop(project);

      expect(await store.head(project)).toBeNull();
      expect(await store.query(project, axisVector(0), 5)).toEqual([]);
    });

    it("ignores an empty upsert and an empty delete", async () => {
      await store.upsert(project, []);
      await store.deleteByPath(project, []);
      expect(await store.head(project)).toBeNull();
    });
  });
}
