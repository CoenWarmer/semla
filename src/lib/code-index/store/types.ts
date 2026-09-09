/**
 * The port every vector store backend implements.
 *
 * Two backends exist — a local one on disk and a pgvector one in Supabase — and
 * one conformance suite runs against both. That suite is the point of the
 * interface: without it the two would drift into disagreeing about ranking
 * order or about what `deleteByPath` removes, and the disagreement would only
 * ever show up as worse answers, never as an error.
 *
 * The port deliberately does not expose "write the manifest". The manifest is
 * derived from the stored rows by `manifest()`, so it cannot describe an index
 * that was never written. See the `fileHash` docblock in ../types.ts.
 */

import type { Fingerprints } from "../fingerprint";
import type { EmbeddedChunk, IndexHead, ProjectKey, ScoredChunk } from "../types";

export type StoreId = "local" | "pgvector";

/** What a caller supplies to stamp an index run. The row count is not its business. */
export type HeadInput = Omit<IndexHead, "version" | "chunks">;

export interface VectorStore {
  readonly id: StoreId;

  /** The stored head, or null when this project has never been indexed. */
  head(project: ProjectKey): Promise<IndexHead | null>;

  /**
   * Stamp the index. Called once, after the rows for a run are in, so a crash
   * mid-run leaves a head describing the *previous* complete state rather than
   * a half-written one.
   */
  putHead(project: ProjectKey, head: HeadInput): Promise<void>;

  /** Replace every chunk for the paths present in `chunks`, then insert these. */
  upsert(project: ProjectKey, chunks: readonly EmbeddedChunk[]): Promise<void>;

  /** Remove every chunk belonging to these paths. */
  deleteByPath(project: ProjectKey, paths: readonly string[]): Promise<void>;

  /** Path -> file hash, derived from the stored rows. */
  manifest(project: ProjectKey): Promise<Fingerprints>;

  /**
   * Top `k` by cosine similarity. `vector` must be unit-normalized, as stored
   * vectors are, so the comparison is a dot product.
   */
  query(
    project: ProjectKey,
    vector: Float32Array,
    k: number,
  ): Promise<ScoredChunk[]>;

  /** Remove the project's index entirely. Idempotent. */
  drop(project: ProjectKey): Promise<void>;
}
