/**
 * AST chunking, against the real vendored grammars.
 *
 * These load wasm, so they are slower than the rest of the suite and worth it:
 * the thing being tested is agreement with an actual parser, and a stubbed one
 * would only test this file's idea of a syntax tree.
 */

import { describe, expect, it } from "vitest";

import { chunkByAst } from "./ast-chunk";
import { chunkFile } from "./chunk";
import { hashContent } from "./fingerprint";
import { readChunkText } from "./chunk";

function input(content: string, language = "typescript" as const) {
  return { path: "src/a.ts", content, language, fileHash: hashContent(content) };
}

describe("chunkByAst", () => {
  it("parses TypeScript and reports the ast strategy", async () => {
    const chunks = await chunkByAst(input("export const a = 1;\n"));
    expect(chunks).not.toBeNull();
    expect(chunks![0].strategy).toBe("ast");
  });

  it("names chunks after the declaration they hold", async () => {
    const chunks = await chunkByAst(
      input("export function alpha() {\n  return 1;\n}\n"),
    );
    expect(chunks![0].symbol).toBe("alpha");
  });

  it("names a class", async () => {
    const chunks = await chunkByAst(input("export class Beta {\n  go() {}\n}\n"));
    expect(chunks![0].symbol).toBe("Beta");
  });

  /**
   * The measured failure that motivated this module. A docblock is a *sibling*
   * of the declaration it documents in the parse tree, so line chunking left it
   * standing alone — and because this repository's docblocks are long and
   * conceptual, those chunks ranked above the code for every conceptual query.
   */
  it("attaches a docblock to the declaration it documents", async () => {
    const content = [
      "/**",
      " * Decides whether the index is out of date.",
      " */",
      "export function isStale() {",
      "  return true;",
      "}",
      "",
    ].join("\n");

    const chunks = await chunkByAst(input(content));

    expect(chunks).toHaveLength(1);
    expect(chunks![0]).toMatchObject({ startLine: 1, symbol: "isStale" });
    // The docblock is inside the chunk, not a chunk of its own.
    expect(readChunkText(content, chunks![0])).toContain("out of date");
    expect(readChunkText(content, chunks![0])).toContain("isStale");
  });

  it("attaches a line comment the same way", async () => {
    const content = ["// counts things", "export function count() {}", ""].join("\n");
    const chunks = await chunkByAst(input(content));

    expect(chunks![0].startLine).toBe(1);
    expect(chunks![0].symbol).toBe("count");
  });

  /**
   * A comment far above the next declaration is a file banner or a section
   * header, not documentation for what follows, and folding it in would put an
   * unrelated preamble inside a function's chunk.
   */
  it("leaves a distant comment standing on its own", async () => {
    const content = [
      "// file banner",
      "",
      "",
      "",
      "export function far() {}",
      "",
    ].join("\n");

    const chunks = await chunkByAst(input(content));
    expect(chunks!.some((chunk) => chunk.symbol === "far")).toBe(true);
    expect(chunks![0].startLine).toBe(1);
  });

  it("keeps each declaration's lines contiguous and in order", async () => {
    const content = [
      "export function one() { return 1; }",
      "",
      "export function two() { return 2; }",
      "",
      "export function three() { return 3; }",
      "",
    ].join("\n");

    const chunks = await chunkByAst(input(content));
    for (let index = 1; index < chunks!.length; index++) {
      expect(chunks![index].startLine).toBeGreaterThan(chunks![index - 1].endLine);
    }
  });

  it("hashes exactly what the query path reads back", async () => {
    const content = [
      "import { x } from './x';",
      "",
      "/** Does a thing. */",
      "export function alpha() {",
      "  return x;",
      "}",
      "",
      "/** Does another. */",
      "export class Beta {",
      "  go() { return 2; }",
      "}",
      "",
    ].join("\n");

    for (const chunk of (await chunkByAst(input(content)))!) {
      const text = readChunkText(content, chunk);
      expect(text).not.toBeNull();
      expect(hashContent(text!)).toBe(chunk.hash);
    }
  });

  it("splits a file too large for one chunk", async () => {
    const many = Array.from(
      { length: 60 },
      (_, index) =>
        `/** Documentation for function number ${index}, which does a thing. */\n` +
        `export function fn${index}(argument: number): number {\n` +
        `  return argument + ${index};\n}\n`,
    ).join("\n");

    const chunks = await chunkByAst(input(many));
    expect(chunks!.length).toBeGreaterThan(1);
    expect(chunks!.every((chunk) => chunk.strategy === "ast")).toBe(true);
  });

  it("parses other vendored grammars", async () => {
    const python = await chunkByAst({
      path: "a.py",
      content: "def alpha(x):\n    return x + 1\n",
      language: "python",
      fileHash: "f",
    });
    expect(python![0]).toMatchObject({ strategy: "ast", symbol: "alpha" });

    const go = await chunkByAst({
      path: "a.go",
      content: "package main\n\nfunc Alpha() int {\n\treturn 1\n}\n",
      language: "go",
      fileHash: "f",
    });
    expect(go!.some((chunk) => chunk.symbol === "Alpha")).toBe(true);
  });

  it("returns null for source it cannot parse into anything", async () => {
    expect(await chunkByAst(input(""))).toBeNull();
  });
});

describe("chunkFile strategy selection", () => {
  it("uses the parser for a grammar-backed language", async () => {
    const chunks = await chunkFile(input("export function a() {}\n"));
    expect(chunks[0].strategy).toBe("ast");
  });

  it("falls back to lines for a language with no grammar", async () => {
    const chunks = await chunkFile({
      path: "docs/a.md",
      content: "# Title\n\nSome prose.\n",
      language: "markdown",
      fileHash: "f",
    });
    expect(chunks[0].strategy).toBe("lines");
  });

  it("falls back to lines rather than failing when a parse yields nothing", async () => {
    // An empty TypeScript file parses to no declarations; the file is simply
    // not indexed, rather than being reported as a broken language.
    expect(await chunkFile(input("\n\n"))).toEqual([]);
  });
});
