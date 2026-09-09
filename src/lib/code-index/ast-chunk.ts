/**
 * Chunking a file along its syntax tree.
 *
 * The measured problem this exists to fix: with line chunking, the first live
 * run of this pipeline ranked `reindex-queue.ts`'s header comment above
 * `fingerprint.ts`'s actual staleness logic, because this repository writes
 * very large docblocks and a blank line separates a docblock from the thing it
 * documents. tree-sitter parses that comment as a *sibling* of the declaration
 * that follows it, so the fix is explicit: a leading comment is attached to the
 * next declaration rather than being allowed to form a chunk of its own.
 *
 * The walk is deliberately shallow — top-level declarations, and the members of
 * a class or namespace when the declaration as a whole exceeds the budget.
 * Descending further produces chunks too small to carry meaning: an embedding
 * of one three-line method is dominated by its signature.
 */

import { estimateTokens, MAX_CHUNK_TOKENS, TARGET_CHUNK_TOKENS } from "./chunk";
import { hashContent } from "./fingerprint";
import { isTestPath, type GrammarLanguage } from "./languages";
import { parseSource, type SyntaxNode } from "./parser";
import type { Chunk } from "./types";

/** Node types that are a comment in every grammar vendored here. */
const COMMENT_TYPES = new Set(["comment", "line_comment", "block_comment"]);

/**
 * Node types worth descending into when the whole declaration is too large.
 * Everything else is emitted whole or split by lines.
 */
const CONTAINER_TYPES = new Set([
  "class_declaration",
  "class_body",
  "class_definition",
  "abstract_class_declaration",
  "interface_declaration",
  "internal_module",
  "module",
  "namespace_declaration",
  "object_type",
  "impl_item",
  "declaration_list",
]);

/** Field names grammars use for a declaration's name, in preference order. */
const NAME_FIELDS = ["name", "declarator", "path"];

export interface AstChunkInput {
  path: string;
  content: string;
  language: GrammarLanguage;
  fileHash: string;
}

/**
 * Chunk by syntax, or null when no grammar is available.
 *
 * Null rather than a line-chunked fallback, so the caller decides and records
 * which strategy was actually used — a chunk that says `"ast"` must have been
 * parsed.
 */
export async function chunkByAst(input: AstChunkInput): Promise<Chunk[] | null> {
  const tree = await parseSource(input.language, input.content);
  if (tree === null) return null;

  const lines = input.content.split("\n");
  const units = collectUnits(tree.rootNode.children, lines);
  if (units.length === 0) return null;

  return packUnits(units, input, lines);
}

/** A top-level construct with any docblock that belongs to it folded in. */
interface Unit {
  startLine: number;
  endLine: number;
  symbol?: string;
  tokens: number;
}

/**
 * Fold each comment into the declaration that follows it.
 *
 * A comment separated from the next declaration by more than one blank line is
 * left standing on its own: at that distance it is a section header or a file
 * banner, not documentation for what comes next.
 */
function collectUnits(nodes: readonly SyntaxNode[], lines: readonly string[]): Unit[] {
  const units: Unit[] = [];
  let pendingComment: SyntaxNode | null = null;

  for (const node of nodes) {
    if (COMMENT_TYPES.has(node.type)) {
      // Two adjacent comments: keep the earlier one as its own unit.
      if (pendingComment !== null) units.push(toUnit(pendingComment, pendingComment, lines));
      pendingComment = node;
      continue;
    }

    const attach =
      pendingComment !== null &&
      node.startPosition.row - pendingComment.endPosition.row <= 2;

    units.push(toUnit(attach ? pendingComment! : node, node, lines));
    if (pendingComment !== null && !attach) {
      units.splice(units.length - 1, 0, toUnit(pendingComment, pendingComment, lines));
    }
    pendingComment = null;
  }

  if (pendingComment !== null) units.push(toUnit(pendingComment, pendingComment, lines));
  return units;
}

function toUnit(from: SyntaxNode, to: SyntaxNode, lines: readonly string[]): Unit {
  const startLine = from.startPosition.row + 1;
  const endLine = to.endPosition.row + 1;
  return {
    startLine,
    endLine,
    symbol: nameOf(to),
    tokens: estimateTokens(lines.slice(startLine - 1, endLine).join("\n")),
  };
}

/** The declared name, looked for on the node and one level in. */
function nameOf(node: SyntaxNode): string | undefined {
  for (const field of NAME_FIELDS) {
    const named = node.childForFieldName(field);
    if (named?.text) return named.text.split("\n")[0].slice(0, 120);
  }
  // `export function foo()` wraps the declaration one level down.
  for (const child of node.namedChildren) {
    for (const field of NAME_FIELDS) {
      const named = child.childForFieldName(field);
      if (named?.text) return named.text.split("\n")[0].slice(0, 120);
    }
  }
  return undefined;
}

/**
 * Group units into chunks up to the budget.
 *
 * A unit over the ceiling on its own is split by lines rather than descending
 * into it: the shallow walk is the design, and a 2,000-token function is one
 * thing however it is cut.
 */
function packUnits(
  units: readonly Unit[],
  input: AstChunkInput,
  lines: readonly string[],
): Chunk[] {
  const chunks: Chunk[] = [];
  let pending: Unit[] = [];
  let pendingTokens = 0;

  const flush = (): void => {
    if (pending.length === 0) return;
    chunks.push(
      makeChunk(
        input,
        lines,
        pending[0].startLine,
        pending[pending.length - 1].endLine,
        // The name of a chunk holding one declaration is that declaration's;
        // a chunk holding several is named for the first, which is what a
        // reader scanning results will match against.
        pending.find((unit) => unit.symbol !== undefined)?.symbol,
      ),
    );
    pending = [];
    pendingTokens = 0;
  };

  for (const unit of units) {
    if (unit.tokens > MAX_CHUNK_TOKENS) {
      flush();
      for (const piece of splitByLines(unit, lines)) {
        chunks.push(makeChunk(input, lines, piece.startLine, piece.endLine, unit.symbol));
      }
      continue;
    }
    if (pendingTokens + unit.tokens > TARGET_CHUNK_TOKENS) flush();
    pending.push(unit);
    pendingTokens += unit.tokens;
  }

  flush();
  return chunks;
}

function splitByLines(unit: Unit, lines: readonly string[]): Unit[] {
  const pieces: Unit[] = [];
  let startLine = unit.startLine;
  let tokens = 0;

  for (let line = unit.startLine; line <= unit.endLine; line++) {
    tokens += estimateTokens(lines[line - 1] ?? "");
    if (tokens >= TARGET_CHUNK_TOKENS && line < unit.endLine) {
      pieces.push({ startLine, endLine: line, symbol: unit.symbol, tokens });
      startLine = line + 1;
      tokens = 0;
    }
  }

  pieces.push({ startLine, endLine: unit.endLine, symbol: unit.symbol, tokens });
  return pieces;
}

function makeChunk(
  input: AstChunkInput,
  lines: readonly string[],
  startLine: number,
  endLine: number,
  symbol: string | undefined,
): Chunk {
  return {
    path: input.path,
    startLine,
    endLine,
    ...(symbol === undefined ? {} : { symbol }),
    // Over the contiguous range, matching what the query path reads back. See
    // makeChunk in chunk.ts — hashing anything else makes every hit stale.
    hash: hashContent(lines.slice(startLine - 1, endLine).join("\n")),
    fileHash: input.fileHash,
    strategy: "ast",
    kind: isTestPath(input.path) ? "test" : "source",
  };
}

/** Container types are exported for the test that pins the shallow walk. */
export const AST_CONTAINER_TYPES: ReadonlySet<string> = CONTAINER_TYPES;
