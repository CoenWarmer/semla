/**
 * Splitting a file into units worth embedding.
 *
 * The goal is a chunk that means something on its own: one function, one class,
 * one section of a document. A chunk cut through the middle of a function
 * embeds as neither half, and retrieves for neither.
 *
 * Two strategies behind one signature. `"ast"` walks a tree-sitter parse and
 * groups sibling nodes until the budget is reached, splitting between
 * declarations rather than inside them — that is the strategy for the fifteen
 * languages with a grammar, and it lands here once
 * `@mrclrchtr/supi-tree-sitter` is declared at the root (see AGENTS.md on
 * extension dependencies; the nested copy must not be imported).
 *
 * `"lines"` is what ships first and what Markdown, JSON and YAML will keep
 * using. It is not a naive character split: it accumulates whole *blocks*
 * separated by blank lines, which in practice tracks function and paragraph
 * boundaries closely enough to be useful, and it never splits a line.
 *
 * Every chunk records which strategy produced it, so a retrieval result can
 * say whether it is citing a parsed declaration or a window of text.
 */

import { hashContent } from "./fingerprint";
import { hasGrammar, type IndexLanguage } from "./languages";
import type { Chunk } from "./types";

/**
 * Target chunk size in tokens.
 *
 * A starting value, not a measured optimum — the open question in
 * docs/plans/code-index.md §5 is whether a chunk should be one function or one
 * function plus the imports that give it meaning. Large enough to hold a
 * typical function with its docblock, small enough that a hit points somewhere
 * specific rather than at half a file.
 */
export const TARGET_CHUNK_TOKENS = 600;

/**
 * A chunk is cut rather than grown past this. Blocks longer than the target on
 * their own — a long function, a table — are allowed to overshoot to stay
 * whole, but not without limit.
 */
export const MAX_CHUNK_TOKENS = 1_200;

/**
 * Characters per token, for budgeting only.
 *
 * Measured against this repository: 4.3 MB of source over ~1.2M tokens. Source
 * code runs denser than prose because identifiers and punctuation tokenize
 * finely. This never has to be exact — it decides where to cut, and the cost of
 * being wrong is a chunk somewhat larger or smaller than intended, not an
 * error. Calling a tokenizer per file to do better would cost more than it buys.
 */
const CHARS_PER_TOKEN = 3.6;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export interface ChunkFileInput {
  /** Project-relative POSIX path, carried onto every chunk. */
  path: string;
  content: string;
  language: IndexLanguage;
  /** sha256 of the whole file, so the manifest stays derivable from the rows. */
  fileHash: string;
}

/**
 * Split one file. Returns [] for a file with no indexable content, which is a
 * normal outcome rather than a failure — an empty file, or one that is entirely
 * whitespace.
 */
export function chunkFile(input: ChunkFileInput): Chunk[] {
  // The AST strategy is not wired yet; until it is, a grammar-backed language
  // is chunked by lines and says so, rather than claiming a parse it did not do.
  void hasGrammar(input.language);
  return chunkByLines(input);
}

/** A run of consecutive non-blank lines, with its position in the file. */
interface Block {
  startLine: number;
  endLine: number;
  text: string;
}

/**
 * Accumulate blank-line-separated blocks up to the token budget.
 *
 * Blocks are never split across chunks unless a single block exceeds
 * MAX_CHUNK_TOKENS on its own, which is the only case where a cut lands inside
 * what the author wrote as one unit.
 */
export function chunkByLines(input: ChunkFileInput): Chunk[] {
  const lines = input.content.split("\n");
  const blocks = splitIntoBlocks(lines);
  if (blocks.length === 0) return [];

  const chunks: Chunk[] = [];
  let pending: Block[] = [];
  let pendingTokens = 0;

  const flush = (): void => {
    if (pending.length === 0) return;
    chunks.push(
      makeChunk(input, lines, pending[0].startLine, pending[pending.length - 1].endLine),
    );
    pending = [];
    pendingTokens = 0;
  };

  for (const block of blocks) {
    const blockTokens = estimateTokens(block.text);

    if (blockTokens > MAX_CHUNK_TOKENS) {
      // Too big to sit with anything else, and too big to keep whole.
      flush();
      for (const piece of splitOversizedBlock(block)) {
        chunks.push(makeChunk(input, lines, piece.startLine, piece.endLine));
      }
      continue;
    }

    if (pendingTokens + blockTokens > TARGET_CHUNK_TOKENS) flush();
    pending.push(block);
    pendingTokens += blockTokens;
  }

  flush();
  return chunks;
}

function splitIntoBlocks(lines: readonly string[]): Block[] {
  const blocks: Block[] = [];
  let current: string[] = [];
  let startLine = 1;

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (line.trim() === "") {
      if (current.length > 0) {
        blocks.push({ startLine, endLine: lineNumber - 1, text: current.join("\n") });
        current = [];
      }
      return;
    }
    if (current.length === 0) startLine = lineNumber;
    current.push(line);
  });

  if (current.length > 0) {
    blocks.push({ startLine, endLine: lines.length, text: current.join("\n") });
  }
  return blocks;
}

/** Cut a single over-long block on line boundaries. Never mid-line. */
function splitOversizedBlock(block: Block): Block[] {
  const lines = block.text.split("\n");
  const pieces: Block[] = [];
  let current: string[] = [];
  let startLine = block.startLine;

  lines.forEach((line, index) => {
    const lineNumber = block.startLine + index;
    const wouldBe = [...current, line].join("\n");
    if (current.length > 0 && estimateTokens(wouldBe) > TARGET_CHUNK_TOKENS) {
      pieces.push({ startLine, endLine: lineNumber - 1, text: current.join("\n") });
      current = [];
      startLine = lineNumber;
    }
    current.push(line);
  });

  if (current.length > 0) {
    pieces.push({ startLine, endLine: block.endLine, text: current.join("\n") });
  }
  return pieces;
}

/**
 * Build a chunk, hashing *exactly* the contiguous line range it cites.
 *
 * Not the blocks that were accumulated to choose the range. Those are joined
 * with a single blank line, while the file may have had two, or a line of
 * trailing whitespace — so hashing the accumulation makes the chunk's hash
 * disagree with `readChunkText` on a file nobody has touched, and every hit
 * reports itself stale. The hash's only job is to answer "does the file still
 * say this", so it has to be taken over what the query path will read.
 */
function makeChunk(
  input: ChunkFileInput,
  lines: readonly string[],
  startLine: number,
  endLine: number,
): Chunk {
  return {
    path: input.path,
    startLine,
    endLine,
    hash: hashContent(lines.slice(startLine - 1, endLine).join("\n")),
    fileHash: input.fileHash,
    strategy: "lines",
  };
}

/**
 * Read a chunk's text back out of the file it cites.
 *
 * The counterpart to storing citations rather than copies: this is what the
 * query path calls, and comparing `hashContent` of the result against the
 * chunk's `hash` is what turns a moved file into a reportable staleness rather
 * than a wrong answer. Returns null when the range no longer exists.
 */
export function readChunkText(content: string, chunk: Chunk): string | null {
  const lines = content.split("\n");
  if (chunk.startLine < 1 || chunk.endLine > lines.length) return null;
  return lines.slice(chunk.startLine - 1, chunk.endLine).join("\n");
}
