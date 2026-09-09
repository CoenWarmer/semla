/**
 * Running an index: the stages joined up, and the accounting that says what
 * actually happened.
 *
 * Two entry points, because the two callers want different things.
 * `indexProject` reconciles a whole project against what is stored — the
 * opt-in ingest, and the session-start freshness check, which are the same
 * operation differing only in how much turns out to be stale.
 * `reindexPaths` re-does named files, which is what the write-triggered queue
 * calls.
 *
 * Both are incremental by construction. A file whose content hash is unchanged
 * is never re-embedded, so the cost of an index run is proportional to what
 * changed rather than to the size of the project: re-running against an
 * untouched tree costs one directory walk and one pass of hashing — 36 ms for
 * this repository — and no network at all.
 *
 * Everything is reported rather than assumed. `IndexReport` carries what was
 * embedded and what was skipped and why, because an index run that quietly did
 * a third of the work is indistinguishable from one that worked until someone
 * searches for the missing part.
 *
 * Token and cost totals are deliberately *not* on the report. Only the embedder
 * sees a response's usage, and it is handed one `onUsage` at construction by
 * whoever built it — so the caller already has the number, and a field here
 * could only be filled by estimating it. An estimate presented next to measured
 * counts reads as measured.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { chunkFile } from "./chunk";
import { enumerateProject } from "./enumerate";
import {
  diffFingerprints,
  fingerprintFiles,
  isUnchanged,
  treeRoot,
  type Fingerprints,
} from "./fingerprint";
import { attachVectors, type Embedder } from "./embed";
import { languageOf } from "./languages";
import type { VectorStore } from "./store/types";
import type { Chunk, ProjectKey, SkipReport } from "./types";

export interface IndexOptions {
  /** Absolute path of the project being indexed. */
  root: string;
  project: ProjectKey;
  store: VectorStore;
  embedder: Embedder;
  /** Called as files are processed, for a progress bar. */
  onProgress?: (progress: IndexProgress) => void;
}

export interface IndexProgress {
  phase: "scanning" | "chunking" | "embedding" | "storing";
  done: number;
  total: number;
}

export interface IndexReport {
  /** False when nothing needed doing — the common case at session start. */
  changed: boolean;
  filesAdded: number;
  filesChanged: number;
  filesRemoved: number;
  chunksWritten: number;
  /** Set when the whole index was discarded and rebuilt, with the reason. */
  rebuiltBecause?: string;
  skipped: SkipReport;
  merkleRoot: string;
  durationMs: number;
}

/**
 * Bring a project's index up to date with the tree on disk.
 *
 * A stored index built by a different embedding model is dropped rather than
 * extended. Vectors from two models cannot be compared — the similarity is not
 * weak but meaningless, and it fails with confidently ranked garbage and no
 * error — so a mixed index is worse than no index.
 */
export async function indexProject(options: IndexOptions): Promise<IndexReport> {
  const started = Date.now();
  const { root, project, store, embedder, onProgress } = options;

  onProgress?.({ phase: "scanning", done: 0, total: 0 });
  const { files, skipped } = await enumerateProject(root);
  const { fingerprints, unreadable } = await fingerprintFiles(
    root,
    files.map((file) => file.path),
  );
  skipped.unreadable.push(...unreadable);

  const head = await store.head(project);
  const modelChanged =
    head !== null && (head.model !== embedder.model || head.dim !== embedder.dim);

  if (modelChanged) {
    await store.drop(project);
  }

  const indexed: Fingerprints = modelChanged ? {} : await store.manifest(project);
  const diff = diffFingerprints(indexed, fingerprints);
  const merkleRoot = treeRoot(fingerprints);

  if (!modelChanged && isUnchanged(diff) && head !== null) {
    return {
      changed: false,
      filesAdded: 0,
      filesChanged: 0,
      filesRemoved: 0,
      chunksWritten: 0,
      skipped,
      merkleRoot,
      durationMs: Date.now() - started,
    };
  }

  const toEmbed = [...diff.added, ...diff.changed].sort();
  const chunksWritten = await embedPaths({
    root,
    project,
    store,
    embedder,
    paths: toEmbed,
    fingerprints,
    onProgress,
  });

  if (diff.removed.length > 0) {
    await store.deleteByPath(project, diff.removed);
  }

  await store.putHead(project, {
    root,
    model: embedder.model,
    dim: embedder.dim,
    merkleRoot,
    updated: new Date().toISOString(),
  });

  return {
    changed: true,
    filesAdded: diff.added.length,
    filesChanged: diff.changed.length,
    filesRemoved: diff.removed.length,
    chunksWritten,
    ...(modelChanged
      ? {
          rebuiltBecause:
            `the embedding model changed to ${embedder.model} (${embedder.dim}d); ` +
            "vectors from two models cannot be compared",
        }
      : {}),
    skipped,
    merkleRoot,
    durationMs: Date.now() - started,
  };
}

/**
 * Re-index named files. What the write-triggered queue calls.
 *
 * A path that has disappeared is deleted from the index rather than treated as
 * an error: the agent may have written a file and then moved it within the same
 * turn, and the queue coalesces both into one path.
 */
export async function reindexPaths(
  options: IndexOptions & { paths: readonly string[] },
): Promise<{ chunksWritten: number; removed: number }> {
  const { root, project, store, embedder, paths } = options;

  const indexable = paths.filter((path) => languageOf(path) !== null);
  const { fingerprints, unreadable } = await fingerprintFiles(root, indexable);

  const gone = indexable.filter((path) => unreadable.includes(path));
  if (gone.length > 0) await store.deleteByPath(project, gone);

  const present = indexable.filter((path) => path in fingerprints);
  const chunksWritten = await embedPaths({
    root,
    project,
    store,
    embedder,
    paths: present,
    fingerprints,
  });

  return { chunksWritten, removed: gone.length };
}

/** Chunk, embed and upsert a set of paths. Shared by both entry points. */
async function embedPaths({
  root,
  project,
  store,
  embedder,
  paths,
  fingerprints,
  onProgress,
}: {
  root: string;
  project: ProjectKey;
  store: VectorStore;
  embedder: Embedder;
  paths: readonly string[];
  fingerprints: Fingerprints;
  onProgress?: (progress: IndexProgress) => void;
}): Promise<number> {
  if (paths.length === 0) return 0;

  const chunks: Chunk[] = [];
  const texts: string[] = [];

  for (const [position, path] of paths.entries()) {
    onProgress?.({ phase: "chunking", done: position, total: paths.length });

    const language = languageOf(path);
    if (language === null) continue;

    let content: string;
    try {
      content = await readFile(join(root, path), "utf-8");
    } catch {
      continue;
    }

    const fileChunks = await chunkFile({
      path,
      content,
      language,
      fileHash: fingerprints[path],
    });

    // The text embedded is the contiguous range the chunk cites, which is what
    // the query path reads back and hash-checks. Slicing it here rather than
    // re-reading per chunk keeps that guarantee in one place.
    const lines = content.split("\n");
    for (const chunk of fileChunks) {
      chunks.push(chunk);
      texts.push(lines.slice(chunk.startLine - 1, chunk.endLine).join("\n"));
    }
  }

  if (chunks.length === 0) {
    // Every path was empty or unparseable. Their old chunks still have to go,
    // or the index keeps citing content that is no longer there.
    await store.deleteByPath(project, paths);
    return 0;
  }

  onProgress?.({ phase: "embedding", done: 0, total: chunks.length });
  const vectors = await embedder.embed(texts);

  onProgress?.({ phase: "storing", done: chunks.length, total: chunks.length });

  // Paths that produced no chunks this time are dropped explicitly: `upsert`
  // only replaces paths present in what it is given.
  const produced = new Set(chunks.map((chunk) => chunk.path));
  const emptied = paths.filter((path) => !produced.has(path));
  if (emptied.length > 0) await store.deleteByPath(project, emptied);

  await store.upsert(project, attachVectors(chunks, vectors));
  return chunks.length;
}
