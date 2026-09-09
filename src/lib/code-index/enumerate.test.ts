/**
 * What gets indexed, and — the part that matters more — what the enumerator
 * admits it left out. Every exclusion here is one the model would otherwise
 * mistake for "searched and found nothing".
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { enumerateProject, MAX_FILE_BYTES } from "./enumerate";
import { hasGrammar, languageOf } from "./languages";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "semla-enum-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(relativePath: string, content: string): void {
  const absolute = join(root, relativePath);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, content, "utf-8");
}

describe("languageOf", () => {
  it("maps the extensions this repository is written in", () => {
    expect(languageOf("src/a.ts")).toBe("typescript");
    expect(languageOf("src/a.tsx")).toBe("tsx");
    expect(languageOf("scripts/a.mjs")).toBe("javascript");
    expect(languageOf("docs/plans/a.md")).toBe("markdown");
    expect(languageOf("supabase/migrations/a.sql")).toBe("sql");
  });

  it("returns null for a file with no extension or an unknown one", () => {
    expect(languageOf("Makefile")).toBeNull();
    expect(languageOf("a.bin")).toBeNull();
    expect(languageOf(".gitignore")).toBeNull();
  });

  it("separates grammar-backed languages from line-chunked ones", () => {
    expect(hasGrammar("typescript")).toBe(true);
    expect(hasGrammar("markdown")).toBe(false);
  });
});

describe("enumerateProject", () => {
  it("finds source files and reports the tree as fully walked", async () => {
    write("src/a.ts", "export const a = 1;\n");
    write("src/nested/b.tsx", "export const B = () => null;\n");
    write("docs/plan.md", "# plan\n");

    const { files, skipped } = await enumerateProject(root);

    expect(files.map((file) => file.path)).toEqual([
      "docs/plan.md",
      "src/a.ts",
      "src/nested/b.tsx",
    ]);
    expect(skipped.complete).toBe(true);
    expect(files[1]).toMatchObject({ language: "typescript" });
  });

  it("returns paths in a stable order regardless of directory iteration", async () => {
    for (const name of ["z.ts", "a.ts", "m.ts"]) write(`src/${name}`, "x\n");
    const first = (await enumerateProject(root)).files.map((f) => f.path);
    const second = (await enumerateProject(root)).files.map((f) => f.path);

    expect(first).toEqual(["src/a.ts", "src/m.ts", "src/z.ts"]);
    expect(second).toEqual(first);
  });

  it("never descends into dependency or build directories", async () => {
    write("src/a.ts", "keep\n");
    write("node_modules/pkg/index.ts", "skip\n");
    write("dist/out.js", "skip\n");
    write(".next/chunk.js", "skip\n");

    const { files } = await enumerateProject(root);
    expect(files.map((file) => file.path)).toEqual(["src/a.ts"]);
  });

  it("records unsupported files rather than dropping them", async () => {
    write("src/a.ts", "keep\n");
    write("assets/logo.png", "binary-ish\n");

    const { files, skipped } = await enumerateProject(root);
    expect(files.map((file) => file.path)).toEqual(["src/a.ts"]);
    expect(skipped.unsupported).toContain("assets/logo.png");
  });

  it("records oversized files rather than dropping them", async () => {
    write("src/small.ts", "ok\n");
    write("src/huge.ts", "x".repeat(MAX_FILE_BYTES + 1));

    const { files, skipped } = await enumerateProject(root);
    expect(files.map((file) => file.path)).toEqual(["src/small.ts"]);
    expect(skipped.tooLarge).toEqual(["src/huge.ts"]);
  });

  it("skips empty files without calling them skipped", async () => {
    write("src/a.ts", "");
    write("src/b.ts", "real\n");

    const { files, skipped } = await enumerateProject(root);
    expect(files.map((file) => file.path)).toEqual(["src/b.ts"]);
    expect(skipped.tooLarge).toEqual([]);
    expect(skipped.unsupported).toEqual([]);
  });

  /**
   * The budget is the guard against being pointed at a workspace root by
   * mistake. Running out of it does not make the result wrong, it makes it
   * partial — and a partial walk presented as a complete one is the failure
   * `walkFiles` already reports for the file browser.
   */
  it("reports an incomplete walk instead of presenting a partial tree as whole", async () => {
    for (let index = 0; index < 40; index++) write(`src/f${index}.ts`, "x\n");

    const { skipped } = await enumerateProject(root, { budget: 5 });
    expect(skipped.complete).toBe(false);
  });
});
