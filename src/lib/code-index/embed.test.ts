/**
 * The embedder, against a stubbed fetch. No live call: the endpoint's observed
 * behaviour is encoded in these stubs, and a test that needs the network is one
 * that stops running.
 *
 * The failure this file is mostly about is the undetectable one. A vector
 * attached to the wrong chunk produces no error anywhere downstream — the store
 * accepts it, the ranking looks plausible, and the citations point at unrelated
 * code. So the ordering guarantees are tested harder than the happy path.
 */

import { describe, expect, it, vi } from "vitest";

import {
  attachVectors,
  batchTexts,
  createOpenRouterEmbedder,
  normalize,
} from "./embed";
import type { Chunk } from "./types";

/** A response shaped like OpenRouter's, with vectors distinguishable per input. */
function respondWith(
  entries: { index?: number; embedding?: number[] }[],
  init: { status?: number; usage?: unknown } = {},
) {
  return new Response(
    JSON.stringify({ data: entries, usage: init.usage ?? { total_tokens: 3, cost: 6e-8 } }),
    { status: init.status ?? 200, headers: { "content-type": "application/json" } },
  );
}

function embedder(fetchImpl: typeof fetch, overrides = {}) {
  return createOpenRouterEmbedder({
    apiKey: "test-key",
    dim: 2,
    fetchImpl,
    maxAttempts: 3,
    ...overrides,
  });
}

describe("createOpenRouterEmbedder", () => {
  it("embeds a batch and returns one vector per input", async () => {
    const fetchImpl = vi.fn(async () =>
      respondWith([
        { index: 0, embedding: [3, 4] },
        { index: 1, embedding: [0, 5] },
      ]),
    ) as unknown as typeof fetch;

    const vectors = await embedder(fetchImpl).embed(["a", "b"]);

    expect(vectors).toHaveLength(2);
    // Float32, so compared approximately: 0.6 stored as f32 is 0.6000000238.
    expect(vectors[0][0]).toBeCloseTo(0.6, 6); // 3-4-5, normalized
    expect(vectors[0][1]).toBeCloseTo(0.8, 6);
    expect(Array.from(vectors[1])).toEqual([0, 1]);
  });

  /**
   * The response array's order is not promised; `index` is. Getting this wrong
   * attaches every vector to the wrong chunk and is invisible from then on.
   */
  it("restores order from `index`, not from array position", async () => {
    const fetchImpl = vi.fn(async () =>
      respondWith([
        { index: 1, embedding: [0, 1] },
        { index: 0, embedding: [1, 0] },
      ]),
    ) as unknown as typeof fetch;

    const vectors = await embedder(fetchImpl).embed(["first", "second"]);

    expect(Array.from(vectors[0])).toEqual([1, 0]);
    expect(Array.from(vectors[1])).toEqual([0, 1]);
  });

  it("falls back to array position when the response omits `index`", async () => {
    const fetchImpl = vi.fn(async () =>
      respondWith([{ embedding: [1, 0] }, { embedding: [0, 1] }]),
    ) as unknown as typeof fetch;

    const vectors = await embedder(fetchImpl).embed(["a", "b"]);
    expect(Array.from(vectors[0])).toEqual([1, 0]);
  });

  it("normalizes vectors the provider returned only nearly unit-length", async () => {
    // 0.999849 was the measured norm from the live endpoint.
    const fetchImpl = vi.fn(async () =>
      respondWith([{ index: 0, embedding: [0.999849, 0] }]),
    ) as unknown as typeof fetch;

    const [vector] = await embedder(fetchImpl).embed(["a"]);
    expect(vector[0]).toBeCloseTo(1, 6);
  });

  it("sends `dimensions` when truncating, and reports the truncated size", async () => {
    const fetchImpl = vi.fn(async () =>
      respondWith([{ index: 0, embedding: [1, 0] }]),
    ) as unknown as typeof fetch;

    const instance = embedder(fetchImpl, { dim: 3072, dimensions: 2 });
    await instance.embed(["a"]);

    const body = JSON.parse(
      (vi.mocked(fetchImpl).mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.dimensions).toBe(2);
    // The head must record what is stored, not the model's native width.
    expect(instance.dim).toBe(2);
  });

  it("rejects a response whose dimension disagrees with the configuration", async () => {
    const fetchImpl = vi.fn(async () =>
      respondWith([{ index: 0, embedding: [1, 0, 0, 0] }]),
    ) as unknown as typeof fetch;

    await expect(embedder(fetchImpl).embed(["a"])).rejects.toThrow(/dimensions/i);
  });

  it("rejects a response with the wrong number of vectors", async () => {
    const fetchImpl = vi.fn(async () =>
      respondWith([{ index: 0, embedding: [1, 0] }]),
    ) as unknown as typeof fetch;

    await expect(embedder(fetchImpl).embed(["a", "b"])).rejects.toThrow(/expected 2/);
  });

  it("retries a 429 and succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockResolvedValueOnce(respondWith([{ index: 0, embedding: [1, 0] }])) as unknown as typeof fetch;

    const vectors = await embedder(fetchImpl).embed(["a"]);
    expect(Array.from(vectors[0])).toEqual([1, 0]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 400, which would fail identically every time", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("bad model", { status: 400 }),
    ) as unknown as typeof fetch;

    await expect(embedder(fetchImpl).embed(["a"])).rejects.toThrow(/400/);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("gives up after the attempt limit", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("nope", { status: 503 }),
    ) as unknown as typeof fetch;

    await expect(embedder(fetchImpl, { maxAttempts: 2 }).embed(["a"])).rejects.toThrow(
      /503/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reports usage so a run can total its own cost", async () => {
    const onUsage = vi.fn();
    const fetchImpl = vi.fn(async () =>
      respondWith([{ index: 0, embedding: [1, 0] }], {
        usage: { total_tokens: 42, cost: 0.00001 },
      }),
    ) as unknown as typeof fetch;

    await embedder(fetchImpl, { onUsage }).embed(["a"]);
    expect(onUsage).toHaveBeenCalledWith({ tokens: 42, cost: 0.00001 });
  });

  it("makes no request for no input", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(await embedder(fetchImpl).embed([])).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("splits a large input across requests and keeps order across them", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      const base = call;
      call += body.input.length;
      return respondWith(
        body.input.map((_: string, offset: number) => ({
          index: offset,
          embedding: [base + offset, 0],
        })),
      );
    }) as unknown as typeof fetch;

    const vectors = await embedder(fetchImpl, { batchSize: 2 }).embed(["a", "b", "c"]);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(vectors).toHaveLength(3);
    // Normalized, so magnitude is lost; the zeroth stays [0,0] and the rest [1,0].
    expect(Array.from(vectors[0])).toEqual([0, 0]);
    expect(Array.from(vectors[2])).toEqual([1, 0]);
  });
});

describe("batchTexts", () => {
  it("splits by count", () => {
    expect(batchTexts(["a", "b", "c"], 2, 1_000)).toEqual([["a", "b"], ["c"]]);
  });

  it("splits by characters when that limit comes first", () => {
    expect(batchTexts(["aaaa", "bbbb", "cc"], 100, 8)).toEqual([
      ["aaaa", "bbbb"],
      ["cc"],
    ]);
  });

  it("sends an oversized text alone rather than dropping it", () => {
    // Dropping it would leave a hole in the index that nothing reports.
    expect(batchTexts(["x".repeat(50), "y"], 10, 10)).toEqual([
      ["x".repeat(50)],
      ["y"],
    ]);
  });

  it("returns nothing for no input", () => {
    expect(batchTexts([], 10, 10)).toEqual([]);
  });
});

describe("normalize", () => {
  it("scales to unit length", () => {
    const vector = normalize([3, 4]);
    expect(vector[0]).toBeCloseTo(0.6, 6);
    expect(vector[1]).toBeCloseTo(0.8, 6);
  });

  it("leaves an all-zero vector alone rather than dividing by zero", () => {
    expect(Array.from(normalize([0, 0]))).toEqual([0, 0]);
  });

  it("treats a non-finite component as zero", () => {
    const vector = normalize([Number.NaN, 3, 4]);
    expect(vector[0]).toBe(0);
    expect(vector[1]).toBeCloseTo(0.6, 6);
  });
});

describe("attachVectors", () => {
  const chunk = (path: string): Chunk => ({
    path,
    startLine: 1,
    endLine: 2,
    hash: `h-${path}`,
    fileHash: `f-${path}`,
    strategy: "lines",
  });

  it("pairs chunks with vectors positionally", () => {
    const attached = attachVectors(
      [chunk("a.ts"), chunk("b.ts")],
      [new Float32Array([1, 0]), new Float32Array([0, 1])],
    );

    expect(attached[0].path).toBe("a.ts");
    expect(Array.from(attached[0].vector)).toEqual([1, 0]);
  });

  it("refuses a length mismatch rather than pairing silently", () => {
    expect(() => attachVectors([chunk("a.ts")], [])).toThrow(/0 vectors for 1 chunks/);
  });
});
