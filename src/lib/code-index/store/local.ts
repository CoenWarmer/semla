/**
 * The on-disk vector store: three files per project, no dependency, no network.
 *
 * `vectors.bin` is an 8-byte header — magic plus the dimension — followed by a
 * flat Float32Array of `rows * dim`, row-major.
 * `chunks.jsonl` is one JSON object per line, positionally parallel to it.
 * `head.json` is the model identity and Merkle root.
 *
 * The dimension is in the vector file rather than in `head.json` because the
 * rows are written before the head is stamped: a run that writes chunks and
 * then crashes must still read back as the rows it wrote, and an index that
 * needed the head to interpret its own vectors read back as empty instead.
 * Self-describing also makes the truncation check below exact rather than
 * inferred from a ratio.
 *
 * Brute force is the right answer at this scale and it is worth saying why
 * rather than leaving it to look like a shortcut. This repository indexes to
 * roughly 2,000 chunks; at 1536 dimensions a full scan is ~3M multiply-adds
 * over one contiguous Float32Array, which is sub-millisecond. An approximate
 * index (HNSW and friends) exists to trade recall for time that is not being
 * spent here, and it would add a native dependency and a second thing that can
 * be subtly wrong. The pgvector backend is where an ANN index earns its place,
 * because there the alternative is shipping every vector over a network.
 *
 * Every write is atomic — temp file, then rename. A half-written `vectors.bin`
 * whose length disagrees with `chunks.jsonl` is not a crash, it is a store that
 * answers queries with vectors read from the wrong offsets, which is the
 * confidently-wrong failure this harness exists to refuse.
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Fingerprints } from "../fingerprint";
import { projectIndexPaths } from "../index-paths";
import type {
  Chunk,
  EmbeddedChunk,
  IndexHead,
  ProjectKey,
  ScoredChunk,
} from "../types";
import type { VectorStore } from "./types";

/** A chunk as stored: everything but the vector, which lives in vectors.bin. */
type StoredChunk = Chunk;

/** "SVX1" — a wrong or truncated file is rejected rather than misread. */
const VECTOR_MAGIC = 0x53565831;
const HEADER_BYTES = 8;

interface LoadedIndex {
  chunks: StoredChunk[];
  vectors: Float32Array;
  dim: number;
}

export function createLocalVectorStore(): VectorStore {
  return {
    id: "local",

    async head(project) {
      return readJson<IndexHead>(projectIndexPaths(project).head);
    },

    async putHead(project, head) {
      const loaded = await load(project);
      const paths = projectIndexPaths(project);
      await mkdir(paths.dir, { recursive: true });
      const stamped: IndexHead = {
        version: 1,
        ...head,
        chunks: loaded?.chunks.length ?? 0,
      };
      await writeAtomic(paths.head, JSON.stringify(stamped, null, 2));
    },

    async upsert(project, incoming) {
      if (incoming.length === 0) return;
      assertUniformDimension(incoming);

      const loaded = await load(project);
      const dim = incoming[0].vector.length;
      if (loaded !== null && loaded.dim !== dim) {
        throw new Error(
          `code-index: refusing to mix ${loaded.dim}-dimensional vectors with ` +
            `${dim}-dimensional ones. The embedding model changed; rebuild the index.`,
        );
      }

      // Replacing by path rather than by chunk hash: a file whose chunk
      // boundaries moved leaves orphans otherwise, and an orphan is a citation
      // to a line range that no longer means what it says.
      const replaced = new Set(incoming.map((chunk) => chunk.path));
      const kept = filterRows(loaded, (chunk) => !replaced.has(chunk.path));

      const chunks = [...kept.chunks, ...incoming.map(withoutVector)];
      const vectors = concatVectors(kept.vectors, incoming, dim);
      await persist(project, chunks, vectors, dim);
    },

    async deleteByPath(project, paths) {
      if (paths.length === 0) return;
      const loaded = await load(project);
      if (loaded === null) return;

      const removed = new Set(paths);
      const kept = filterRows(loaded, (chunk) => !removed.has(chunk.path));
      await persist(project, kept.chunks, kept.vectors, loaded.dim);
    },

    async manifest(project) {
      const loaded = await load(project);
      const manifest: Fingerprints = {};
      for (const chunk of loaded?.chunks ?? []) {
        manifest[chunk.path] = chunk.fileHash;
      }
      return manifest;
    },

    async query(project, vector, k) {
      const loaded = await load(project);
      if (loaded === null || loaded.chunks.length === 0) return [];
      if (vector.length !== loaded.dim) {
        throw new Error(
          `code-index: query vector has ${vector.length} dimensions, index has ` +
            `${loaded.dim}. The embedding model changed; rebuild the index.`,
        );
      }

      const { chunks, vectors, dim } = loaded;
      const scored: ScoredChunk[] = new Array(chunks.length);
      for (let row = 0; row < chunks.length; row++) {
        let dot = 0;
        const base = row * dim;
        for (let axis = 0; axis < dim; axis++) {
          dot += vectors[base + axis] * vector[axis];
        }
        scored[row] = { ...chunks[row], score: dot };
      }

      // Ties broken by path then start line, so two runs over the same index
      // return the same order. A ranking that reshuffles between identical
      // queries is not reproducible, and reproducibility is the product here.
      scored.sort(
        (left, right) =>
          right.score - left.score ||
          left.path.localeCompare(right.path) ||
          left.startLine - right.startLine,
      );
      return scored.slice(0, Math.max(0, k));
    },

    async drop(project) {
      await rm(projectIndexPaths(project).dir, { recursive: true, force: true });
    },
  };
}

// ── internals ─────────────────────────────────────────────

async function load(project: ProjectKey): Promise<LoadedIndex | null> {
  const paths = projectIndexPaths(project);

  let raw: Buffer;
  let lines: string;
  try {
    [raw, lines] = await Promise.all([
      readFile(paths.vectors),
      readFile(paths.chunks, "utf-8"),
    ]);
  } catch {
    return null;
  }

  if (raw.byteLength < HEADER_BYTES) return null;
  if (raw.readUInt32LE(0) !== VECTOR_MAGIC) return null;
  const dim = raw.readUInt32LE(4);
  if (dim === 0) return null;

  const chunks = lines
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as StoredChunk);

  // Copied rather than viewed in place: `readFile` returns a Buffer from a
  // shared pool whose byteOffset carries no alignment guarantee, and a
  // Float32Array view onto an odd offset throws.
  const body = new Uint8Array(raw.subarray(HEADER_BYTES));
  const vectors = new Float32Array(body.buffer);

  // The two files are written together and must describe the same rows. If they
  // do not, something truncated one of them, and every offset past that point
  // reads another chunk's vector — so the index is discarded rather than
  // half-trusted.
  if (vectors.length !== chunks.length * dim) return null;

  return { chunks, vectors, dim };
}

function encodeVectors(vectors: Float32Array, dim: number): Buffer {
  const out = Buffer.allocUnsafe(HEADER_BYTES + vectors.byteLength);
  out.writeUInt32LE(VECTOR_MAGIC, 0);
  out.writeUInt32LE(dim, 4);
  Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength).copy(
    out,
    HEADER_BYTES,
  );
  return out;
}

function filterRows(
  loaded: LoadedIndex | null,
  keep: (chunk: StoredChunk) => boolean,
): { chunks: StoredChunk[]; vectors: Float32Array } {
  if (loaded === null) return { chunks: [], vectors: new Float32Array(0) };

  const { chunks, vectors, dim } = loaded;
  const keptRows: number[] = [];
  const keptChunks: StoredChunk[] = [];
  for (let row = 0; row < chunks.length; row++) {
    if (keep(chunks[row])) {
      keptRows.push(row);
      keptChunks.push(chunks[row]);
    }
  }

  const out = new Float32Array(keptRows.length * dim);
  keptRows.forEach((row, target) => {
    out.set(vectors.subarray(row * dim, row * dim + dim), target * dim);
  });
  return { chunks: keptChunks, vectors: out };
}

function concatVectors(
  kept: Float32Array,
  incoming: readonly EmbeddedChunk[],
  dim: number,
): Float32Array {
  const out = new Float32Array(kept.length + incoming.length * dim);
  out.set(kept, 0);
  incoming.forEach((chunk, position) => {
    out.set(chunk.vector, kept.length + position * dim);
  });
  return out;
}

async function persist(
  project: ProjectKey,
  chunks: readonly StoredChunk[],
  vectors: Float32Array,
  dim: number,
): Promise<void> {
  const paths = projectIndexPaths(project);
  await mkdir(paths.dir, { recursive: true });
  await writeAtomic(
    paths.chunks,
    chunks.map((chunk) => JSON.stringify(chunk)).join("\n"),
  );
  await writeAtomic(paths.vectors, encodeVectors(vectors, dim));

  // The head carries the row count, so it is restamped whenever the rows move.
  const head = await readJson<IndexHead>(paths.head);
  if (head !== null && head.chunks !== chunks.length) {
    await writeAtomic(
      paths.head,
      JSON.stringify({ ...head, chunks: chunks.length }, null, 2),
    );
  }
}

function withoutVector(chunk: EmbeddedChunk): StoredChunk {
  const { vector: _vector, ...rest } = chunk;
  return rest;
}

function assertUniformDimension(chunks: readonly EmbeddedChunk[]): void {
  const dim = chunks[0].vector.length;
  for (const chunk of chunks) {
    if (chunk.vector.length !== dim) {
      throw new Error(
        `code-index: chunk ${chunk.path}:${chunk.startLine} has ` +
          `${chunk.vector.length} dimensions, expected ${dim}.`,
      );
    }
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

async function writeAtomic(path: string, data: string | Buffer): Promise<void> {
  const temporary = join(
    path.slice(0, path.lastIndexOf("/")),
    `.${randomBytes(6).toString("hex")}.tmp`,
  );
  await writeFile(temporary, data);
  await rename(temporary, path);
}
