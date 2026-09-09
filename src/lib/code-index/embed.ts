/**
 * Turning chunk text into vectors, through OpenRouter.
 *
 * OpenRouter because it is the only provider in Semla's agent directory — every
 * chat model in the harness already resolves through it — so the index needs no
 * second vendor and no second key. Its `/api/v1/embeddings` is OpenAI
 * wire-compatible, which also means `@zosmaai/pi-llm-wiki`'s own embedder can
 * be pointed at the same endpoint with the same credential.
 *
 * Three things about that endpoint were established by probing it rather than
 * from documentation, because it is absent from the `/api/v1/models` listing
 * (430 chat models, no embedding models):
 *
 *  - **Batching works**, and each result carries its `index`. The order of the
 *    returned array is not promised, so it is restored from that field rather
 *    than assumed — a silent transposition here would attach every vector to
 *    the wrong chunk, and nothing downstream could detect it.
 *  - **`dimensions` truncation works**, so `text-embedding-3-large` can be cut
 *    to 1536 and fit under pgvector's HNSW ceiling of 2000.
 *  - **Vectors come back nearly, but not exactly, unit-length** — 0.999849 for
 *    a measured sample. Close enough to look normalized and not close enough to
 *    be. Every vector is normalized here, because the store's dot product *is*
 *    the cosine similarity and an unnormalized vector makes it quietly not.
 */

import type { Chunk, EmbeddedChunk } from "./types";

export const DEFAULT_EMBEDDING_MODEL = "openai/text-embedding-3-small";
export const DEFAULT_EMBEDDING_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * Texts per request. The endpoint accepts more, but a failed batch is retried
 * whole, so a larger batch means more work thrown away on one 429.
 */
export const DEFAULT_BATCH_SIZE = 96;

/**
 * Characters per request, whichever limit is reached first. A batch of large
 * chunks hits a token ceiling long before it hits the count.
 */
export const DEFAULT_BATCH_CHARS = 96_000;

/** A resolved embedding backend. Injected everywhere, so tests need no network. */
export interface Embedder {
  /** Model label, stored in the index head as part of its identity. */
  readonly model: string;
  /** Vector dimensionality, known before the first call. */
  readonly dim: number;
  /** Embed texts, returning unit-length vectors positionally aligned to input. */
  embed(texts: readonly string[]): Promise<Float32Array[]>;
}

export interface OpenRouterEmbedderOptions {
  apiKey: string;
  /** Defaults to openai/text-embedding-3-small. */
  model?: string;
  /**
   * Native dimensionality of `model`, or the truncated size when `dimensions`
   * is set. Required because the index head records it before anything is
   * embedded, and a head that disagrees with its vectors is unrecoverable.
   */
  dim: number;
  /** Sent as `dimensions`, for models supporting Matryoshka truncation. */
  dimensions?: number;
  baseUrl?: string;
  batchSize?: number;
  batchChars?: number;
  /** Injected for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Attempts per batch, including the first. */
  maxAttempts?: number;
  /** Called after each request with what it cost, for the run's total. */
  onUsage?: (usage: EmbeddingUsage) => void;
}

export interface EmbeddingUsage {
  tokens: number;
  /** OpenRouter reports this per response; absent on some upstreams. */
  cost?: number;
}

/**
 * An error that must not be retried, marked so the retry loop's own `catch`
 * does not swallow the decision. Throwing a plain Error from inside the `try`
 * put it straight into the handler that retries, so a 400 was sent three times
 * -- the exact thing the retryable check exists to prevent.
 */
class NonRetryableEmbeddingError extends Error {
  readonly retryable = false as const;
}

function isNonRetryable(error: unknown): boolean {
  return error instanceof NonRetryableEmbeddingError;
}

interface EmbeddingResponse {
  data?: { index?: number; embedding?: number[] }[];
  usage?: { total_tokens?: number; prompt_tokens?: number; cost?: number };
  error?: { message?: string; code?: number };
}

export function createOpenRouterEmbedder({
  apiKey,
  model = DEFAULT_EMBEDDING_MODEL,
  dim,
  dimensions,
  baseUrl = DEFAULT_EMBEDDING_BASE_URL,
  batchSize = DEFAULT_BATCH_SIZE,
  batchChars = DEFAULT_BATCH_CHARS,
  fetchImpl,
  maxAttempts = 3,
  onUsage,
}: OpenRouterEmbedderOptions): Embedder {
  const doFetch = fetchImpl ?? globalThis.fetch;
  // What is actually stored: the truncated width when `dimensions` is set, the
  // model's native width otherwise. Validating against the native width while
  // asking for a truncated one rejects every correct response.
  const effectiveDim = dimensions ?? dim;

  async function embedBatch(texts: readonly string[]): Promise<Float32Array[]> {
    const body = JSON.stringify({
      model,
      input: texts,
      ...(dimensions === undefined ? {} : { dimensions }),
    });

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await doFetch(`${baseUrl}/embeddings`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body,
        });

        if (!response.ok) {
          // 429 and 5xx are worth another attempt; a 400 will fail identically
          // however many times it is sent, and retrying it only delays the
          // error that says what is actually wrong.
          const retryable = response.status === 429 || response.status >= 500;
          const detail = await response.text().catch(() => "");
          const message = `code-index: embedding request failed (${response.status}) ${detail.slice(0, 200)}`;
          if (!retryable) throw new NonRetryableEmbeddingError(message);
          const error = new Error(message);
          if (attempt === maxAttempts) throw error;
          lastError = error;
        } else {
          const payload = (await response.json()) as EmbeddingResponse;
          if (payload.error) {
            throw new NonRetryableEmbeddingError(
              `code-index: embedding error: ${payload.error.message}`,
            );
          }
          onUsage?.({
            tokens: payload.usage?.total_tokens ?? payload.usage?.prompt_tokens ?? 0,
            cost: payload.usage?.cost,
          });
          return decodeVectors(payload, texts.length, effectiveDim);
        }
      } catch (error) {
        // A malformed or rejected response fails the same way however many
        // times it is sent; retrying only delays the message that says why.
        if (isNonRetryable(error) || attempt === maxAttempts) throw error;
        lastError = error;
      }

      // Backoff between attempts. Bounded and short: the caller is a background
      // queue, not a user waiting, but a run that stalls for minutes on a rate
      // limit is indistinguishable from one that has hung.
      await delay(Math.min(2_000, 200 * 2 ** (attempt - 1)));
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("code-index: embedding failed");
  }

  return {
    model,
    dim: effectiveDim,

    async embed(texts) {
      if (texts.length === 0) return [];
      const out: Float32Array[] = [];
      for (const batch of batchTexts(texts, batchSize, batchChars)) {
        out.push(...(await embedBatch(batch)));
      }
      return out;
    },
  };
}

/**
 * Split into requests by count and by size, whichever is reached first.
 *
 * A single text over the char budget still goes on its own rather than being
 * dropped: chunking already bounded it, and refusing it here would silently
 * leave a hole in the index.
 */
export function batchTexts(
  texts: readonly string[],
  batchSize: number,
  batchChars: number,
): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let chars = 0;

  for (const text of texts) {
    if (
      current.length > 0 &&
      (current.length >= batchSize || chars + text.length > batchChars)
    ) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(text);
    chars += text.length;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

function decodeVectors(
  payload: EmbeddingResponse,
  expected: number,
  dim: number,
): Float32Array[] {
  const data = payload.data;
  if (!Array.isArray(data) || data.length !== expected) {
    throw new NonRetryableEmbeddingError(
      `code-index: embedding response had ${data?.length ?? 0} vectors, expected ${expected}.`,
    );
  }

  const out = new Array<Float32Array | undefined>(expected);
  data.forEach((entry, position) => {
    // `index` is authoritative; the array order is not promised. Attaching a
    // vector to the wrong chunk is undetectable downstream — it just makes
    // retrieval quietly wrong — so this is not a defensive nicety.
    const slot = entry.index ?? position;
    if (slot < 0 || slot >= expected) {
      throw new NonRetryableEmbeddingError(
        `code-index: embedding response index ${slot} out of range.`,
      );
    }
    if (!Array.isArray(entry.embedding)) {
      throw new NonRetryableEmbeddingError(
        `code-index: embedding response entry ${slot} had no vector.`,
      );
    }
    if (entry.embedding.length !== dim) {
      throw new NonRetryableEmbeddingError(
        `code-index: embedding model returned ${entry.embedding.length} dimensions, ` +
          `expected ${dim}. The configured model and dimension disagree.`,
      );
    }
    out[slot] = normalize(entry.embedding);
  });

  const missing = out.findIndex((vector) => vector === undefined);
  if (missing !== -1) {
    throw new NonRetryableEmbeddingError(
      `code-index: embedding response was missing index ${missing}.`,
    );
  }
  return out as Float32Array[];
}

/**
 * Scale to unit length so the store's dot product is cosine similarity.
 *
 * Not skippable on the grounds that the provider "returns normalized vectors":
 * a measured sample came back at 0.999849, which is close enough to look
 * normalized and not close enough to be.
 */
export function normalize(values: readonly number[]): Float32Array {
  const vector = new Float32Array(values.length);
  let sumOfSquares = 0;
  for (let axis = 0; axis < values.length; axis++) {
    const value = Number.isFinite(values[axis]) ? values[axis] : 0;
    vector[axis] = value;
    sumOfSquares += value * value;
  }

  const magnitude = Math.sqrt(sumOfSquares);
  if (magnitude < 1e-10) return vector; // all zeros; leave it rather than divide
  for (let axis = 0; axis < vector.length; axis++) vector[axis] /= magnitude;
  return vector;
}

/** Attach vectors to the chunks they were produced from, positionally. */
export function attachVectors(
  chunks: readonly Chunk[],
  vectors: readonly Float32Array[],
): EmbeddedChunk[] {
  if (chunks.length !== vectors.length) {
    throw new Error(
      `code-index: ${vectors.length} vectors for ${chunks.length} chunks.`,
    );
  }
  return chunks.map((chunk, position) => ({ ...chunk, vector: vectors[position] }));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
