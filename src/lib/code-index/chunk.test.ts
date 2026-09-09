/**
 * Chunking, and the one property everything downstream rests on: a chunk's hash
 * must equal the hash of what the query path reads back from the file. If those
 * disagree, every hit reports itself stale on a file nobody has touched, and
 * the staleness signal becomes noise that gets ignored — which is worse than
 * not having it.
 */

import { describe, expect, it } from "vitest";

import {
  chunkFile,
  estimateTokens,
  MAX_CHUNK_TOKENS,
  readChunkText,
  TARGET_CHUNK_TOKENS,
} from "./chunk";
import { hashContent } from "./fingerprint";
import type { IndexLanguage } from "./languages";

function chunk(content: string, language: IndexLanguage = "typescript") {
  return chunkFile({
    path: "src/a.ts",
    content,
    language,
    fileHash: hashContent(content),
  });
}

/** Text of roughly `tokens` tokens, as one unbroken block. */
function block(tokens: number, seed = "x"): string {
  return (seed.repeat(11) + "\n").repeat(Math.ceil((tokens * 3.6) / 12));
}

describe("chunkFile", () => {
  it("returns nothing for an empty or whitespace-only file", () => {
    expect(chunk("")).toEqual([]);
    expect(chunk("\n\n   \n\t\n")).toEqual([]);
  });

  it("keeps a small file as one chunk covering it", () => {
    const content = "export function a() {\n  return 1;\n}\n";
    const [only, ...rest] = chunk(content);

    expect(rest).toEqual([]);
    expect(only).toMatchObject({ path: "src/a.ts", startLine: 1, endLine: 3 });
  });

  it("records the strategy that produced it", () => {
    // A grammar-backed language is still line-chunked today, and says so rather
    // than claiming a parse it did not do.
    expect(chunk("const a = 1;\n")[0].strategy).toBe("lines");
    expect(chunk("# Title\n", "markdown")[0].strategy).toBe("lines");
  });

  it("carries the file hash onto every chunk", () => {
    const content = `${block(400)}\n${block(400)}`;
    const chunks = chunk(content);

    expect(chunks.length).toBeGreaterThan(1);
    expect(new Set(chunks.map((one) => one.fileHash)).size).toBe(1);
    expect(chunks[0].fileHash).toBe(hashContent(content));
  });

  it("splits a long file into several chunks", () => {
    const chunks = chunk(`${block(400, "a")}\n${block(400, "b")}\n${block(400, "c")}`);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("groups small adjacent blocks rather than emitting a chunk per block", () => {
    const content = Array.from({ length: 8 }, (_, i) => `const v${i} = ${i};`).join("\n\n");
    expect(chunk(content)).toHaveLength(1);
  });

  it("keeps a block whole when it fits, rather than cutting to hit the target", () => {
    const content = `${block(200, "a")}\n${block(500, "b")}`;
    const chunks = chunk(content);

    // The second block would overflow the target if joined, so it starts a new
    // chunk instead of being split across the boundary.
    expect(chunks).toHaveLength(2);
  });

  it("cuts a single oversized block on line boundaries", () => {
    const chunks = chunk(block(MAX_CHUNK_TOKENS + 400));

    expect(chunks.length).toBeGreaterThan(1);
    for (const one of chunks) {
      expect(one.endLine).toBeGreaterThanOrEqual(one.startLine);
    }
  });

  it("covers the file contiguously and without overlap", () => {
    const chunks = chunk(`${block(400, "a")}\n${block(400, "b")}\n${block(400, "c")}`);

    for (let index = 1; index < chunks.length; index++) {
      expect(chunks[index].startLine).toBeGreaterThan(chunks[index - 1].endLine);
    }
  });

  it("cites line ranges that exist in the file", () => {
    const content = `${block(400, "a")}\n${block(400, "b")}`;
    const lineCount = content.split("\n").length;

    for (const one of chunk(content)) {
      expect(one.startLine).toBeGreaterThanOrEqual(1);
      expect(one.endLine).toBeLessThanOrEqual(lineCount);
    }
  });
});

describe("readChunkText round-trip", () => {
  /**
   * The bug this pins: chunk boundaries are chosen by accumulating
   * blank-line-separated blocks, and hashing that accumulation instead of the
   * contiguous range makes the hash disagree with the read-back on an untouched
   * file — because the join loses the file's own blank lines.
   */
  it("hashes exactly what the query path reads back", () => {
    const content = [
      "import { a } from './a';",
      "",
      "",
      "export function one() {",
      "  return a;",
      "}",
      "",
      "export function two() {",
      "  return 2;",
      "}",
      "",
    ].join("\n");

    for (const one of chunk(content)) {
      const text = readChunkText(content, one);
      expect(text).not.toBeNull();
      expect(hashContent(text!)).toBe(one.hash);
    }
  });

  it("round-trips a file whose blocks are separated by several blank lines", () => {
    const content = `${block(300, "a")}\n\n\n${block(300, "b")}`;
    for (const one of chunk(content)) {
      expect(hashContent(readChunkText(content, one)!)).toBe(one.hash);
    }
  });

  it("detects an edited file through the hash", () => {
    const content = "export function one() {\n  return 1;\n}\n";
    const [only] = chunk(content);
    const edited = content.replace("return 1", "return 2");

    expect(hashContent(readChunkText(edited, only)!)).not.toBe(only.hash);
  });

  it("returns null when the cited range no longer exists", () => {
    const [only] = chunk(`${block(50)}`);
    expect(readChunkText("one line\n", { ...only, endLine: 9_999 })).toBeNull();
  });
});

describe("estimateTokens", () => {
  it("scales with length and stays in the right order of magnitude", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("x".repeat(360))).toBe(100);
    expect(estimateTokens("x".repeat(720))).toBeGreaterThan(estimateTokens("x".repeat(360)));
  });

  it("has a target below its hard ceiling", () => {
    expect(TARGET_CHUNK_TOKENS).toBeLessThan(MAX_CHUNK_TOKENS);
  });
});
