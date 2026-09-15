/**
 * Search, with the exact-match pass stubbed out so the assertions are about
 * ranking and reporting rather than about ripgrep.
 *
 * The bar here is not "returns plausible results" — it is that every way the
 * answer can be incomplete is *said*. An unindexed project, a model mismatch, a
 * moved file, a filtered-out kind: each has to reach the caller as words, not
 * as a shorter list.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Embedder } from "./embed";
import { indexProject } from "./indexer";
import { projectKey } from "./index-paths";
import { renderSearchResult, searchProject } from "./search";
import { createLocalVectorStore } from "./store/local";
import type { ProjectKey } from "./types";

vi.mock("@/lib/pi/review/review-grep", () => ({
  grepProject: vi.fn(async () => ({ matches: [], truncated: false })),
}));

const { grepProject } = await import("@/lib/pi/review/review-grep");

let root: string;
let indexHome: string;
let project: ProjectKey;

function fakeEmbedder(model = "fake/model", dim = 2): Embedder {
  return {
    model,
    dim,
    async embed(texts) {
      return texts.map((text) => {
        const vector = new Float32Array(dim);
        // "alpha" queries land near alpha's chunk, "beta" near beta's.
        vector[0] = text.includes("alpha") ? 1 : 0;
        vector[1] = text.includes("beta") ? 1 : 0;
        if (vector[0] === 0 && vector[1] === 0) vector[0] = 0.5;
        const magnitude = Math.hypot(vector[0], vector[1]) || 1;
        vector[0] /= magnitude;
        vector[1] /= magnitude;
        return vector;
      });
    },
  };
}

function write(relativePath: string, content: string): void {
  const absolute = join(root, relativePath);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, content, "utf-8");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "semla-search-"));
  indexHome = mkdtempSync(join(tmpdir(), "semla-search-home-"));
  process.env.SEMLA_INDEX_HOME = indexHome;
  project = projectKey(root);
  // Cleared, not just re-stubbed: call counts otherwise accumulate across tests
  // and the "does not call grep" assertion passes or fails on test order.
  vi.clearAllMocks();
  vi.mocked(grepProject).mockResolvedValue({ matches: [], truncated: false });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(indexHome, { recursive: true, force: true });
  delete process.env.SEMLA_INDEX_HOME;
});

async function indexed() {
  write("src/alpha.ts", "export function alpha() {\n  return 1;\n}\n");
  write("src/beta.ts", "export function beta() {\n  return 2;\n}\n");
  const store = createLocalVectorStore();
  await indexProject({ root, project, store, embedder: fakeEmbedder() });
  return store;
}

describe("searchProject", () => {
  it("returns citations with the code read from disk", async () => {
    const store = await indexed();

    const result = await searchProject({
      root,
      project,
      store,
      embedder: fakeEmbedder(),
      query: "alpha",
    });

    expect(result.hits.length).toBeGreaterThan(0);
    const [top] = result.hits;
    expect(top.path).toBe("src/alpha.ts");
    expect(top.text).toContain("function alpha");
    expect(top.fresh).toBe(true);
  });

  it("says so, and searches nothing, when the project is not indexed", async () => {
    const result = await searchProject({
      root,
      project,
      store: createLocalVectorStore(),
      embedder: fakeEmbedder(),
      query: "alpha",
    });

    expect(result.hits).toEqual([]);
    expect(result.index).toBeNull();
    expect(result.limits.join(" ")).toMatch(/no code index/i);
  });

  /**
   * Running the query anyway would rank by a similarity between vectors from
   * two different models, which is meaningless and returns a confident order.
   */
  it("refuses to search when the index was built by another model", async () => {
    const store = await indexed();

    const result = await searchProject({
      root,
      project,
      store,
      embedder: fakeEmbedder("other/model"),
      query: "alpha",
    });

    expect(result.hits).toEqual([]);
    expect(result.limits.join(" ")).toMatch(/cannot be compared/);
  });

  it("refuses when only the dimension differs", async () => {
    const store = await indexed();
    const result = await searchProject({
      root,
      project,
      store,
      embedder: fakeEmbedder("fake/model", 4),
      query: "alpha",
    });

    expect(result.limits.join(" ")).toMatch(/cannot be compared/);
  });

  it("marks a hit whose file has changed since indexing", async () => {
    const store = await indexed();
    write("src/alpha.ts", "export function alpha() {\n  return 'edited';\n}\n");

    const result = await searchProject({
      root,
      project,
      store,
      embedder: fakeEmbedder(),
      query: "alpha",
    });

    const hit = result.hits.find((one) => one.path === "src/alpha.ts");
    expect(hit?.fresh).toBe(false);
    expect(result.limits.join(" ")).toMatch(/lines that have changed/);
  });

  it("reports that the tree has moved since the index was built", async () => {
    const store = await indexed();
    write("src/gamma.ts", "export function gamma() {\n  return 3;\n}\n");

    const result = await searchProject({
      root,
      project,
      store,
      embedder: fakeEmbedder(),
      query: "alpha",
    });

    expect(result.staleness?.current).toBe(false);
    expect(result.limits.join(" ")).toMatch(/recent code may be missing/);
  });

  it("says the index matches when it does", async () => {
    const store = await indexed();
    const result = await searchProject({
      root,
      project,
      store,
      embedder: fakeEmbedder(),
      query: "alpha",
    });

    expect(result.staleness?.current).toBe(true);
    expect(result.limits).toEqual([]);
  });

  it("promotes a chunk that also matched literally", async () => {
    const store = await indexed();
    // beta is the literal match; the query vector points at alpha.
    vi.mocked(grepProject).mockResolvedValue({
      matches: [{ path: "src/beta.ts", line: 1, text: "export function beta() {" }],
      truncated: false,
    });

    const result = await searchProject({
      root,
      project,
      store,
      embedder: fakeEmbedder(),
      query: "alpha",
    });

    expect(result.hits[0].path).toBe("src/beta.ts");
    expect(result.hits[0].source).toBe("both");
  });

  it("degrades to semantic-only, and says so, when the exact pass fails", async () => {
    const store = await indexed();
    vi.mocked(grepProject).mockRejectedValue(new Error("rg missing"));

    const result = await searchProject({
      root,
      project,
      store,
      embedder: fakeEmbedder(),
      query: "alpha",
    });

    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.limits.join(" ")).toMatch(/semantic only/);
  });

  it("can skip the exact pass entirely", async () => {
    const store = await indexed();
    await searchProject({
      root,
      project,
      store,
      embedder: fakeEmbedder(),
      query: "alpha",
      exact: false,
    });

    expect(grepProject).not.toHaveBeenCalled();
  });

  it("filters by kind and reports what the filter removed", async () => {
    write("src/alpha.ts", "export function alpha() {\n  return 1;\n}\n");
    write("src/alpha.test.ts", "it('alpha returns 1', () => {\n  expect(1).toBe(1);\n});\n");
    const store = createLocalVectorStore();
    await indexProject({ root, project, store, embedder: fakeEmbedder() });

    const result = await searchProject({
      root,
      project,
      store,
      embedder: fakeEmbedder(),
      query: "alpha",
      kind: "source",
    });

    expect(result.hits.every((hit) => hit.kind === "source")).toBe(true);
    expect(result.limits.join(" ")).toMatch(/Restricted to source/);
  });

  it("honours the limit", async () => {
    const store = await indexed();
    const result = await searchProject({
      root,
      project,
      store,
      embedder: fakeEmbedder(),
      query: "alpha",
      limit: 1,
    });

    expect(result.hits).toHaveLength(1);
  });
});

describe("renderSearchResult", () => {
  it("leads with citations and states its limits", async () => {
    const store = await indexed();
    const result = await searchProject({
      root,
      project,
      store,
      embedder: fakeEmbedder(),
      query: "alpha",
    });

    const text = renderSearchResult(result, "alpha");
    expect(text).toMatch(/src\/alpha\.ts:\d+-\d+/);
    // Absence of bad news is stated, so it cannot be mistaken for an omission.
    expect(text).toContain("Limits: none");
  });

  it("prints the limits when there are any", async () => {
    const result = await searchProject({
      root,
      project,
      store: createLocalVectorStore(),
      embedder: fakeEmbedder(),
      query: "alpha",
    });

    expect(renderSearchResult(result, "alpha")).toMatch(/no code index/i);
  });

  it("marks stale and test results in the rendered text", async () => {
    const store = await indexed();
    write("src/alpha.ts", "export function alpha() {\n  return 'edited';\n}\n");

    const result = await searchProject({
      root,
      project,
      store,
      embedder: fakeEmbedder(),
      query: "alpha",
    });

    expect(renderSearchResult(result, "alpha")).toContain("STALE");
  });
});
