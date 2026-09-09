/**
 * The orchestrator, against a real local store and a fake embedder.
 *
 * The properties worth pinning are about *not* doing work: an unchanged tree
 * must cost no embedding at all, and a changed file must cost only itself. Both
 * are what make the session-start check and the write-triggered queue
 * affordable, and both fail silently if they regress — into a slower, more
 * expensive index that still returns correct answers.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Embedder } from "./embed";
import { indexProject, reindexPaths } from "./indexer";
import { projectKey } from "./index-paths";
import { createLocalVectorStore } from "./store/local";
import type { ProjectKey } from "./types";

let root: string;
let indexHome: string;
let project: ProjectKey;

/** Deterministic vectors: length-2, derived from the text, unit-normalized. */
function fakeEmbedder(model = "fake/model", dim = 2): Embedder & { calls: number } {
  const embedder = {
    model,
    dim,
    calls: 0,
    async embed(texts: readonly string[]) {
      embedder.calls += texts.length;
      return texts.map((text) => {
        const vector = new Float32Array(dim);
        vector[0] = ((text.length % 7) + 1) / 10;
        vector[1] = 1;
        const magnitude = Math.hypot(...Array.from(vector));
        return vector.map((value) => value / magnitude) as Float32Array;
      });
    },
  };
  return embedder;
}

function write(relativePath: string, content: string): void {
  const absolute = join(root, relativePath);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, content, "utf-8");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "semla-idx-"));
  indexHome = mkdtempSync(join(tmpdir(), "semla-idx-home-"));
  process.env.SEMLA_INDEX_HOME = indexHome;
  project = projectKey(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(indexHome, { recursive: true, force: true });
  delete process.env.SEMLA_INDEX_HOME;
});

describe("indexProject", () => {
  it("indexes a project and reports what it did", async () => {
    write("src/a.ts", "export function alpha() {\n  return 1;\n}\n");
    write("src/b.ts", "export function beta() {\n  return 2;\n}\n");

    const store = createLocalVectorStore();
    const report = await indexProject({
      root,
      project,
      store,
      embedder: fakeEmbedder(),
    });

    expect(report.changed).toBe(true);
    expect(report.filesAdded).toBe(2);
    expect(report.chunksWritten).toBeGreaterThanOrEqual(2);
    expect((await store.head(project))?.chunks).toBe(report.chunksWritten);
  });

  /**
   * The property the session-start check rests on. If this regresses, opening a
   * session re-embeds the project.
   */
  it("does no embedding at all when nothing changed", async () => {
    write("src/a.ts", "export function alpha() {\n  return 1;\n}\n");
    const store = createLocalVectorStore();

    await indexProject({ root, project, store, embedder: fakeEmbedder() });

    const second = fakeEmbedder();
    const report = await indexProject({ root, project, store, embedder: second });

    expect(report.changed).toBe(false);
    expect(report.chunksWritten).toBe(0);
    expect(second.calls).toBe(0);
  });

  it("re-embeds only the file that changed", async () => {
    write("src/a.ts", "export function alpha() {\n  return 1;\n}\n");
    write("src/b.ts", "export function beta() {\n  return 2;\n}\n");
    const store = createLocalVectorStore();
    await indexProject({ root, project, store, embedder: fakeEmbedder() });

    write("src/a.ts", "export function alpha() {\n  return 99;\n}\n");
    const second = fakeEmbedder();
    const report = await indexProject({ root, project, store, embedder: second });

    expect(report.filesChanged).toBe(1);
    expect(report.filesAdded).toBe(0);
    // b.ts was not re-embedded.
    expect(second.calls).toBe(report.chunksWritten);
    expect(Object.keys(await store.manifest(project)).sort()).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  it("drops chunks for a deleted file", async () => {
    write("src/a.ts", "export function alpha() {\n  return 1;\n}\n");
    write("src/b.ts", "export function beta() {\n  return 2;\n}\n");
    const store = createLocalVectorStore();
    await indexProject({ root, project, store, embedder: fakeEmbedder() });

    unlinkSync(join(root, "src/b.ts"));
    const report = await indexProject({ root, project, store, embedder: fakeEmbedder() });

    expect(report.filesRemoved).toBe(1);
    expect(Object.keys(await store.manifest(project))).toEqual(["src/a.ts"]);
  });

  /**
   * Extending an index with vectors from a second model would rank by a
   * similarity that means nothing, and would do it without an error.
   */
  it("rebuilds from scratch when the embedding model changes", async () => {
    write("src/a.ts", "export function alpha() {\n  return 1;\n}\n");
    const store = createLocalVectorStore();
    await indexProject({ root, project, store, embedder: fakeEmbedder("model/one") });

    const report = await indexProject({
      root,
      project,
      store,
      embedder: fakeEmbedder("model/two"),
    });

    expect(report.rebuiltBecause).toMatch(/cannot be compared/);
    expect(report.filesAdded).toBe(1);
    expect((await store.head(project))?.model).toBe("model/two");
  });

  it("rebuilds when only the dimension changes", async () => {
    write("src/a.ts", "export function alpha() {\n  return 1;\n}\n");
    const store = createLocalVectorStore();
    await indexProject({ root, project, store, embedder: fakeEmbedder("m", 2) });

    const report = await indexProject({
      root,
      project,
      store,
      embedder: fakeEmbedder("m", 4),
    });

    expect(report.rebuiltBecause).toBeDefined();
    expect((await store.head(project))?.dim).toBe(4);
  });

  it("carries the skip report through", async () => {
    write("src/a.ts", "export const a = 1;\n");
    write("assets/logo.png", "not source\n");

    const report = await indexProject({
      root,
      project,
      store: createLocalVectorStore(),
      embedder: fakeEmbedder(),
    });

    expect(report.skipped.unsupported).toContain("assets/logo.png");
    expect(report.skipped.complete).toBe(true);
  });

  it("reports progress through its phases", async () => {
    write("src/a.ts", "export const a = 1;\n");
    const onProgress = vi.fn();

    await indexProject({
      root,
      project,
      store: createLocalVectorStore(),
      embedder: fakeEmbedder(),
      onProgress,
    });

    const phases = onProgress.mock.calls.map(([progress]) => progress.phase);
    expect(phases).toContain("scanning");
    expect(phases).toContain("embedding");
  });

  it("moves the merkle root when the tree changes", async () => {
    write("src/a.ts", "export const a = 1;\n");
    const store = createLocalVectorStore();
    const first = await indexProject({ root, project, store, embedder: fakeEmbedder() });

    write("src/a.ts", "export const a = 2;\n");
    const second = await indexProject({ root, project, store, embedder: fakeEmbedder() });

    expect(second.merkleRoot).not.toBe(first.merkleRoot);
  });
});

describe("reindexPaths", () => {
  it("re-indexes only the named files", async () => {
    write("src/a.ts", "export function alpha() {\n  return 1;\n}\n");
    write("src/b.ts", "export function beta() {\n  return 2;\n}\n");
    const store = createLocalVectorStore();
    await indexProject({ root, project, store, embedder: fakeEmbedder() });

    write("src/a.ts", "export function alpha() {\n  return 99;\n}\n");
    const embedder = fakeEmbedder();
    const result = await reindexPaths({
      root,
      project,
      store,
      embedder,
      paths: ["src/a.ts"],
    });

    expect(result.chunksWritten).toBeGreaterThan(0);
    expect(embedder.calls).toBe(result.chunksWritten);
  });

  it("removes a file that has since disappeared", async () => {
    write("src/a.ts", "export function alpha() {\n  return 1;\n}\n");
    write("src/b.ts", "export function beta() {\n  return 2;\n}\n");
    const store = createLocalVectorStore();
    await indexProject({ root, project, store, embedder: fakeEmbedder() });

    unlinkSync(join(root, "src/b.ts"));
    const result = await reindexPaths({
      root,
      project,
      store,
      embedder: fakeEmbedder(),
      paths: ["src/b.ts"],
    });

    expect(result.removed).toBe(1);
    expect(Object.keys(await store.manifest(project))).toEqual(["src/a.ts"]);
  });

  it("ignores a path with no indexable language", async () => {
    write("src/a.ts", "export const a = 1;\n");
    const store = createLocalVectorStore();
    await indexProject({ root, project, store, embedder: fakeEmbedder() });

    const embedder = fakeEmbedder();
    const result = await reindexPaths({
      root,
      project,
      store,
      embedder,
      paths: ["assets/logo.png"],
    });

    expect(result).toEqual({ chunksWritten: 0, removed: 0 });
    expect(embedder.calls).toBe(0);
  });
});
