/**
 * The vocabulary of the code index, in one place because six modules and two
 * store backends have to agree on it.
 *
 * The load-bearing idea in these types is that a chunk is a *citation*, not a
 * copy: `path` + `startLine` + `endLine` + `hash`, and no source text. The text
 * is read back off disk at query time, so a chunk whose file has moved on fails
 * its hash check and can be reported as stale rather than returned as fact.
 * See docs/plans/code-index.md §3.1.
 */

/** Stable per-project namespace: a slug of the directory name plus a path hash. */
export type ProjectKey = string & { readonly __brand: "ProjectKey" };

/** How a file's chunks were produced, recorded per file rather than assumed. */
export type ChunkStrategy =
  /** tree-sitter walked the AST and split between declarations. */
  | "ast"
  /** No grammar for this language: fixed line windows with overlap. */
  | "lines";

/** A span of one file, semantically coherent and size-bounded. */
export interface Chunk {
  /** Project-relative POSIX path. Absolute paths never reach the store. */
  path: string;
  /** 1-based, inclusive. Matches the `file:line` citations used everywhere else. */
  startLine: number;
  /** 1-based, inclusive. */
  endLine: number;
  /**
   * Enclosing declaration name where the grammar names one, else undefined.
   * Carried for keyword filtering and for a readable result line; never relied
   * on for identity.
   */
  symbol?: string;
  /** sha256 of the exact text embedded. Drives both caching and staleness. */
  hash: string;
  /**
   * sha256 of the whole file this chunk came from.
   *
   * Carried on every chunk so the change-detection manifest is *derivable* from
   * the stored rows rather than kept in a second file beside them. A manifest
   * held separately is a second source of truth about what is indexed, and the
   * failure it produces is the quiet one: a crash between writing the rows and
   * writing the manifest leaves an index that reports itself current and is not.
   */
  fileHash: string;
  strategy: ChunkStrategy;
}

/** A chunk with its vector. Unit-normalized, so a dot product is cosine. */
export interface EmbeddedChunk extends Chunk {
  vector: Float32Array;
}

/** A retrieval hit. `score` is cosine similarity in [-1, 1]. */
export interface ScoredChunk extends Chunk {
  score: number;
}

/**
 * The index's identity and provenance.
 *
 * `model` and `dim` are here because comparing vectors from two different
 * models is not a weak signal but a meaningless one, and it fails silently:
 * confidently ranked garbage, no error anywhere. A head mismatch forces a
 * rebuild. See docs/plans/code-index.md §3.2.
 */
export interface IndexHead {
  version: 1;
  /** Absolute path of the indexed project, for diagnostics. */
  root: string;
  /** Embedding model label, e.g. "openai/text-embedding-3-small". */
  model: string;
  /** Vector dimensionality. */
  dim: number;
  /** Merkle root of the tree as indexed. Inequality means stale. */
  merkleRoot: string;
  /** Number of chunks stored. */
  chunks: number;
  /** ISO timestamp of the last completed index run. */
  updated: string;
}

/**
 * What the enumerator could not index, kept as data rather than dropped.
 *
 * A retrieval tool that has quietly not read a third of the tree is worse than
 * one that says so: the model cannot tell "no match" from "never looked".
 */
export interface SkipReport {
  /** Files past the size ceiling. */
  tooLarge: string[];
  /** Files whose extension maps to no grammar and no fallback. */
  unsupported: string[];
  /** Files that could not be read at all. */
  unreadable: string[];
  /** False when the directory walk hit its budget before exhausting the tree. */
  complete: boolean;
}
