/**
 * Change detection. The properties that matter are that the root is stable
 * across runs and platforms, that it moves for any change the index cares
 * about, and that the diff never reports work that does not need doing —
 * re-embedding an unchanged file is the whole cost this layer exists to avoid.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  diffFingerprints,
  fingerprintFiles,
  hashContent,
  isUnchanged,
  treeRoot,
  type Fingerprints,
} from "./fingerprint";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "semla-fp-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(relativePath: string, content: string): void {
  const absolute = join(root, relativePath);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, content, "utf-8");
}

describe("fingerprintFiles", () => {
  it("hashes each file by content", async () => {
    write("a.ts", "export const a = 1;\n");
    write("nested/b.ts", "export const b = 2;\n");

    const { fingerprints, unreadable } = await fingerprintFiles(root, [
      "a.ts",
      "nested/b.ts",
    ]);

    expect(unreadable).toEqual([]);
    expect(fingerprints["a.ts"]).toBe(hashContent("export const a = 1;\n"));
    expect(Object.keys(fingerprints).sort()).toEqual(["a.ts", "nested/b.ts"]);
  });

  it("gives identical content the same hash regardless of path", async () => {
    write("a.ts", "same\n");
    write("b.ts", "same\n");
    const { fingerprints } = await fingerprintFiles(root, ["a.ts", "b.ts"]);
    expect(fingerprints["a.ts"]).toBe(fingerprints["b.ts"]);
  });

  it("reports a missing file instead of failing the run", async () => {
    write("a.ts", "ok\n");
    const { fingerprints, unreadable } = await fingerprintFiles(root, [
      "a.ts",
      "gone.ts",
    ]);

    expect(unreadable).toEqual(["gone.ts"]);
    expect(Object.keys(fingerprints)).toEqual(["a.ts"]);
  });

  it("handles more files than its concurrency limit", async () => {
    const paths = Array.from({ length: 50 }, (_, index) => `f${index}.ts`);
    for (const path of paths) write(path, `export const x = ${path};\n`);

    const { fingerprints } = await fingerprintFiles(root, paths, {
      concurrency: 4,
    });
    expect(Object.keys(fingerprints)).toHaveLength(50);
  });
});

describe("treeRoot", () => {
  it("does not depend on insertion order", () => {
    const one: Fingerprints = { "a.ts": "1", "b.ts": "2", "c.ts": "3" };
    const two: Fingerprints = { "c.ts": "3", "a.ts": "1", "b.ts": "2" };
    expect(treeRoot(one)).toBe(treeRoot(two));
  });

  it("moves when a file's content changes", () => {
    expect(treeRoot({ "a.ts": "1" })).not.toBe(treeRoot({ "a.ts": "2" }));
  });

  it("moves when a file is added or removed", () => {
    const base = treeRoot({ "a.ts": "1" });
    expect(treeRoot({ "a.ts": "1", "b.ts": "2" })).not.toBe(base);
    expect(treeRoot({})).not.toBe(base);
  });

  /**
   * A rename changes no content hash, but chunks cite `path`, so a citation to
   * the old name is a stale answer. The root has to move or the index will
   * report itself current while pointing at a file that is gone.
   */
  it("moves when a file is renamed with identical content", () => {
    expect(treeRoot({ "a.ts": "1" })).not.toBe(treeRoot({ "b.ts": "1" }));
  });

  it("cannot be fooled by a path/hash boundary shift", () => {
    // Without a delimiter between path and hash these two would fold to the
    // same byte stream.
    expect(treeRoot({ ab: "c" })).not.toBe(treeRoot({ a: "bc" }));
  });
});

describe("diffFingerprints", () => {
  const indexed: Fingerprints = { "a.ts": "1", "b.ts": "2", "c.ts": "3" };

  it("finds added, changed and removed", () => {
    const diff = diffFingerprints(indexed, {
      "a.ts": "1", // untouched
      "b.ts": "changed",
      "d.ts": "4", // added
      // c.ts removed
    });

    expect(diff).toEqual({
      added: ["d.ts"],
      changed: ["b.ts"],
      removed: ["c.ts"],
    });
    expect(isUnchanged(diff)).toBe(false);
  });

  it("reports nothing to do for an identical tree", () => {
    expect(isUnchanged(diffFingerprints(indexed, { ...indexed }))).toBe(true);
  });

  it("treats a first index as all-added", () => {
    expect(diffFingerprints({}, indexed).added).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("sorts its output so a run is reproducible", () => {
    const diff = diffFingerprints({}, { "z.ts": "1", "a.ts": "2", "m.ts": "3" });
    expect(diff.added).toEqual(["a.ts", "m.ts", "z.ts"]);
  });
});
