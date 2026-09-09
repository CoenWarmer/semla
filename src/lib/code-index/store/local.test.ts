/**
 * The local backend against the shared VectorStore contract, plus the two
 * failure modes that are specific to keeping vectors and metadata in separate
 * files on disk.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { projectIndexPaths, projectKey } from "../index-paths";
import { createLocalVectorStore } from "./local";
import { axisVector, chunkAt, describeVectorStore } from "./conformance";

let indexHome: string;

beforeEach(() => {
  indexHome = mkdtempSync(join(tmpdir(), "semla-index-"));
  process.env.SEMLA_INDEX_HOME = indexHome;
});

afterEach(() => {
  rmSync(indexHome, { recursive: true, force: true });
  delete process.env.SEMLA_INDEX_HOME;
});

describeVectorStore("local", () => ({
  store: createLocalVectorStore(),
  setup: () => projectKey("/repo/demo"),
}));

describe("local vector store, on-disk specifics", () => {
  it("keeps two projects apart", async () => {
    const store = createLocalVectorStore();
    const one = projectKey("/repo/one");
    const two = projectKey("/repo/two");

    await store.upsert(one, [chunkAt("a.ts", 1, axisVector(0))]);
    await store.upsert(two, [chunkAt("b.ts", 1, axisVector(1))]);

    expect((await store.query(one, axisVector(0), 5)).map((h) => h.path)).toEqual(["a.ts"]);
    expect((await store.query(two, axisVector(1), 5)).map((h) => h.path)).toEqual(["b.ts"]);
  });

  it("distinguishes projects that share a directory name", async () => {
    // The slug alone collides; the path hash is what makes the key unique.
    expect(projectKey("/a/semla")).not.toBe(projectKey("/b/semla"));
    expect(projectKey("/a/semla")).toMatch(/^semla-[0-9a-f]{12}$/);
  });

  it("survives a process restart", async () => {
    const project = projectKey("/repo/demo");
    await createLocalVectorStore().upsert(project, [
      chunkAt("a.ts", 1, axisVector(0)),
    ]);

    // A second store instance shares nothing but the files.
    const reopened = createLocalVectorStore();
    expect((await reopened.query(project, axisVector(0), 5))[0].path).toBe("a.ts");
  });

  /**
   * The failure this file exists for. `vectors.bin` and `chunks.jsonl` are
   * written together and describe the same rows; if one is truncated, every
   * offset past the truncation reads a different chunk's vector. That is not a
   * crash — it is a store that answers queries with plausible, wrong rankings.
   * It has to be detected, and a discarded index is the correct outcome
   * because the tree on disk can always rebuild it.
   */
  it("discards an index whose vectors and metadata disagree", async () => {
    const store = createLocalVectorStore();
    const project = projectKey("/repo/demo");
    await store.upsert(project, [
      chunkAt("a.ts", 1, axisVector(0)),
      chunkAt("b.ts", 1, axisVector(1)),
    ]);

    const paths = projectIndexPaths(project);
    const lines = readFileSync(paths.chunks, "utf-8").split("\n");
    writeFileSync(paths.chunks, lines[0], "utf-8"); // one row of metadata, two of vectors

    expect(await store.query(project, axisVector(0), 5)).toEqual([]);
    expect(await store.manifest(project)).toEqual({});
  });

  it("writes a self-describing vector file the head does not have to explain", async () => {
    const store = createLocalVectorStore();
    const project = projectKey("/repo/demo");
    await store.upsert(project, [
      chunkAt("a.ts", 1, axisVector(0, 4)),
      chunkAt("b.ts", 1, axisVector(1, 4)),
    ]);
    await store.putHead(project, {
      root: "/repo/demo",
      model: "openai/text-embedding-3-small",
      dim: 4,
      merkleRoot: "root",
      updated: "2026-09-09T00:00:00.000Z",
    });

    const bytes = readFileSync(projectIndexPaths(project).vectors);
    expect(bytes.readUInt32LE(0)).toBe(0x53565831); // "SVX1"
    expect(bytes.readUInt32LE(4)).toBe(4); // dimension, carried with the vectors
    expect(bytes.byteLength).toBe(8 + 2 * 4 * Float32Array.BYTES_PER_ELEMENT);
  });

  /**
   * The rows must be readable before `putHead` runs. An index that needed its
   * head to interpret its own vectors read back as empty for the whole window
   * between writing chunks and stamping the run — so a crash in that window
   * silently discarded the work, and the next run saw an unindexed project.
   */
  it("reads back rows written before the head was stamped", async () => {
    const store = createLocalVectorStore();
    const project = projectKey("/repo/demo");
    await store.upsert(project, [chunkAt("a.ts", 1, axisVector(0))]);

    expect(await store.head(project)).toBeNull();
    expect((await store.query(project, axisVector(0), 5))[0].path).toBe("a.ts");
    expect(await store.manifest(project)).toEqual({ "a.ts": "file-a.ts" });
  });
});
