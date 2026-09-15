/**
 * Answering a query, and saying what the answer does not cover.
 *
 * Three things happen here that the vector store alone does not do.
 *
 * **Text is read from disk, never from the index.** A hit carries a citation;
 * the code comes from the file it names. That is what makes a moved file a
 * reportable staleness rather than a confidently wrong answer, and it is
 * checked per hit rather than assumed from the index being recent.
 *
 * **Exact matches are merged in.** Semantic scores measured on this repository
 * sit between 0.24 and 0.40 for good and bad hits alike — there is no threshold
 * that separates them — so a query that is *also* a literal string in the code
 * must not lose to a paraphrase that scores marginally higher. ripgrep is
 * already a dependency and `review-grep.ts` already owns the binary path.
 *
 * **Limits are stated.** Following `code_map`, which says where depth or the
 * node cap stopped it: a retrieval tool that cannot be wrong out loud is one
 * whose answers cannot be trusted quietly.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { grepProject } from "@/lib/pi/review/review-grep";

import { readChunkText } from "./chunk";
import { enumerateProject } from "./enumerate";
import { fingerprintFiles, hashContent, treeRoot } from "./fingerprint";
import type { Embedder } from "./embed";
import type { VectorStore } from "./store/types";
import type { Chunk, ChunkKind, IndexHead, ProjectKey } from "./types";

/** How a hit was found. `both` is the strongest signal available here. */
export type HitSource = "semantic" | "exact" | "both";

export interface SearchHit extends Chunk {
  score: number;
  source: HitSource;
  /** The code, read from the file at query time. Null when the range is gone. */
  text: string | null;
  /**
   * False when the file no longer matches what was indexed. The hit is still
   * returned — it is usually still the right place — but it is marked, because
   * the line numbers may have moved.
   */
  fresh: boolean;
}

export interface SearchOptions {
  root: string;
  project: ProjectKey;
  store: VectorStore;
  embedder: Embedder;
  query: string;
  /** Hits returned. */
  limit?: number;
  /**
   * Restrict to implementation or to tests. Unset returns both, ranked
   * together — which lets tests dominate, so callers asking "how does X work"
   * should pass "source".
   */
  kind?: ChunkKind;
  /** Set false to skip the ripgrep pass, for a purely semantic comparison. */
  exact?: boolean;
  /** Set false to skip the freshness check, which costs a walk plus hashing. */
  checkFreshness?: boolean;
}

export interface SearchResult {
  hits: SearchHit[];
  /** Null when the project has never been indexed. */
  index: IndexHead | null;
  /**
   * Whether the tree still matches what was indexed. Null when not checked.
   */
  staleness: StalenessReport | null;
  /** Everything the caller should say out loud rather than let be inferred. */
  limits: string[];
}

export interface StalenessReport {
  /** True when the Merkle root of the tree equals the indexed one. */
  current: boolean;
  indexedRoot: string;
  actualRoot: string;
}

export const DEFAULT_SEARCH_LIMIT = 8;

/** Semantic candidates fetched before filtering and merging. */
const CANDIDATE_MULTIPLIER = 6;

export async function searchProject(options: SearchOptions): Promise<SearchResult> {
  const {
    root,
    project,
    store,
    embedder,
    query,
    limit = DEFAULT_SEARCH_LIMIT,
    kind,
    exact = true,
    checkFreshness = true,
  } = options;

  const head = await store.head(project);
  const limits: string[] = [];

  if (head === null) {
    return {
      hits: [],
      index: null,
      staleness: null,
      limits: [
        "This project has no code index. Nothing was searched semantically — " +
          "build one from Settings, or fall back to grep.",
      ],
    };
  }

  if (head.model !== embedder.model || head.dim !== embedder.dim) {
    // Refused rather than run: a query vector from another model ranks by a
    // similarity that means nothing, and returns a confident, wrong order.
    return {
      hits: [],
      index: head,
      staleness: null,
      limits: [
        `The index was built with ${head.model} (${head.dim}d) but the configured ` +
          `model is ${embedder.model} (${embedder.dim}d). Vectors from two models ` +
          "cannot be compared; re-index before searching.",
      ],
    };
  }

  const [queryVector] = await embedder.embed([query]);
  const candidates = await store.query(project, queryVector, limit * CANDIDATE_MULTIPLIER);

  const filtered =
    kind === undefined
      ? candidates
      : candidates.filter((candidate) => candidate.kind === kind);
  if (kind !== undefined && filtered.length < candidates.length) {
    limits.push(
      `Restricted to ${kind} chunks; ${candidates.length - filtered.length} ` +
        `${kind === "source" ? "test" : "source"} matches were not returned.`,
    );
  }

  const exactPaths = exact ? await exactMatchPaths(root, query, limits) : new Set<string>();

  const ranked = filtered
    .map((candidate) => ({
      ...candidate,
      source: (exactPaths.has(candidate.path) ? "both" : "semantic") as HitSource,
    }))
    // A chunk that also matched literally is promoted above one that only
    // matched by meaning, since the scores themselves do not separate them.
    .sort((left, right) => rankOf(right) - rankOf(left) || right.score - left.score)
    .slice(0, limit);

  const hits = await Promise.all(ranked.map((hit) => withText(root, hit)));

  const staleHits = hits.filter((hit) => !hit.fresh).length;
  if (staleHits > 0) {
    limits.push(
      `${staleHits} of ${hits.length} results cite lines that have changed since ` +
        "indexing; their line numbers may have moved.",
    );
  }

  const staleness = checkFreshness ? await freshness(root, head) : null;
  if (staleness !== null && !staleness.current) {
    limits.push(
      "The tree has changed since this index was built, so recent code may be " +
        "missing from these results entirely.",
    );
  }

  return { hits, index: head, staleness, limits };
}

function rankOf(hit: { source: HitSource }): number {
  return hit.source === "both" ? 1 : 0;
}

/** Paths ripgrep matched literally. Failures degrade to no exact signal. */
async function exactMatchPaths(
  root: string,
  query: string,
  limits: string[],
): Promise<Set<string>> {
  try {
    const { matches, truncated } = await grepProject(root, query);
    if (truncated) {
      limits.push("The exact-match pass hit its result cap; some literal matches are not reflected.");
    }
    return new Set(matches.map((match) => match.path));
  } catch {
    limits.push("The exact-match pass failed; these results are semantic only.");
    return new Set();
  }
}

async function withText(
  root: string,
  hit: Chunk & { score: number; source: HitSource },
): Promise<SearchHit> {
  try {
    const content = await readFile(join(root, hit.path), "utf-8");
    const text = readChunkText(content, hit);
    return {
      ...hit,
      text,
      fresh: text !== null && hashContent(text) === hit.hash,
    };
  } catch {
    // The file is gone. Returned rather than dropped, because "the index thinks
    // this exists and it does not" is information.
    return { ...hit, text: null, fresh: false };
  }
}

async function freshness(root: string, head: IndexHead): Promise<StalenessReport> {
  const { files } = await enumerateProject(root);
  const { fingerprints } = await fingerprintFiles(root, files.map((file) => file.path));
  const actualRoot = treeRoot(fingerprints);
  return {
    current: actualRoot === head.merkleRoot,
    indexedRoot: head.merkleRoot,
    actualRoot,
  };
}

/**
 * Render a result for the model.
 *
 * Citations first and always — `path:start-end` is clickable in the session and
 * checkable by the reader. The limits are printed even when empty of bad news,
 * so their absence is a statement rather than an omission.
 */
export function renderSearchResult(result: SearchResult, query: string): string {
  const lines: string[] = [];

  if (result.index === null) {
    return result.limits.join("\n");
  }

  lines.push(`${result.hits.length} result(s) for "${query}"`);
  lines.push(
    `index: ${result.index.chunks} chunks, ${result.index.model}, built ${result.index.updated}`,
  );
  lines.push("");

  for (const hit of result.hits) {
    const marks = [
      hit.symbol ?? "",
      hit.kind === "test" ? "[test]" : "",
      hit.source === "both" ? "[exact+semantic]" : "",
      hit.fresh ? "" : "[STALE — lines may have moved]",
    ]
      .filter(Boolean)
      .join(" ");

    lines.push(`${hit.path}:${hit.startLine}-${hit.endLine}  ${marks}`.trimEnd());
    lines.push(`  score ${hit.score.toFixed(3)}`);
    if (hit.text !== null) {
      lines.push(...hit.text.split("\n").map((line) => `  | ${line}`));
    }
    lines.push("");
  }

  if (result.limits.length > 0) {
    lines.push("Limits:");
    lines.push(...result.limits.map((limit) => `  - ${limit}`));
  } else {
    lines.push("Limits: none — the index matches the tree on disk.");
  }

  return lines.join("\n");
}
