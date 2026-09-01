import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { walkFiles } from "@/lib/pi/file-walk";

let root: string;

const write = (relPath: string) => {
  const absolute = join(root, relPath);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, "x");
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "semla-walk-"));
  write("semla/src/page.tsx");
  write("semla/src/deep/nested/thing.ts");
  write("semla/node_modules/pkg/index.js");
  write("semla/.git/config");
  write("semla/dist/bundle.js");
  write("other/readme.md");
});

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
});

const collect = async (from: string, options = { budget: 10_000 }) => {
  const found: string[] = [];
  const result = await walkFiles(from, (absolute) => found.push(absolute), options);
  return { found: found.map((p) => p.slice(root.length + 1)).sort(), result };
};

describe("walkFiles", () => {
  it("finds files at any depth", async () => {
    const { found } = await collect(root);
    expect(found).toContain("semla/src/page.tsx");
    expect(found).toContain("semla/src/deep/nested/thing.ts");
    expect(found).toContain("other/readme.md");
  });

  it("skips dependencies, build output and dot directories", async () => {
    const { found } = await collect(root);
    expect(found.some((p) => p.includes("node_modules"))).toBe(false);
    expect(found.some((p) => p.includes("dist"))).toBe(false);
    expect(found.some((p) => p.includes(".git"))).toBe(false);
  });

  it("leaves out a directory the caller asked to skip", async () => {
    const found: string[] = [];
    await walkFiles(root, (absolute) => found.push(absolute), {
      budget: 10_000,
      skip: new Set([join(root, "semla")]),
    });
    expect(found.map((p) => p.slice(root.length + 1))).toEqual(["other/readme.md"]);
  });

  it("reports an exhausted budget instead of silently truncating", async () => {
    const { result } = await collect(root, { budget: 2 });
    expect(result.complete).toBe(false);
    expect(result.examined).toBe(2);
  });

  it("reports completion when the tree fits in the budget", async () => {
    const { result } = await collect(root);
    expect(result.complete).toBe(true);
  });

  it("returns an empty, complete walk for a directory it cannot read", async () => {
    const { found, result } = await collect(join(root, "does-not-exist"));
    expect(found).toEqual([]);
    expect(result.complete).toBe(true);
  });
});
