import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isGitRepository, listProjectFiles } from "@/lib/pi/project-files";

let repo: string;
let plain: string;

const write = (root: string, relPath: string, body = "x") => {
  const absolute = join(root, relPath);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, body);
};

const collect = async (dir: string, budget = 10_000) => {
  const found: string[] = [];
  const result = await listProjectFiles(dir, (relPath) => found.push(relPath), {
    budget,
  });
  return { found: found.sort(), result };
};

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "semla-repo-"));
  write(repo, ".gitignore", "ignored.txt\nbuilt/\n");
  write(repo, "src/page.tsx");
  write(repo, "src/deep/nested/thing.ts");
  write(repo, "ignored.txt");
  write(repo, "built/bundle.js");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["add", "src", ".gitignore"], { cwd: repo });

  plain = mkdtempSync(join(tmpdir(), "semla-plain-"));
  write(plain, "notes/readme.md");
  write(plain, "node_modules/pkg/index.js");
});

afterAll(() => {
  rmSync(repo, { force: true, recursive: true });
  rmSync(plain, { force: true, recursive: true });
});

describe("isGitRepository", () => {
  it("recognises a checkout", () => {
    expect(isGitRepository(repo)).toBe(true);
  });

  it("does not claim a plain directory", () => {
    expect(isGitRepository(plain)).toBe(false);
  });
});

describe("listProjectFiles in a repository", () => {
  it("reports paths relative to the project, not absolute", async () => {
    const { found } = await collect(repo);
    expect(found).toContain("src/page.tsx");
    expect(found).toContain("src/deep/nested/thing.ts");
    expect(found.every((path) => !path.startsWith("/"))).toBe(true);
  });

  it("honours .gitignore, so build output never reaches the results", async () => {
    const { found } = await collect(repo);
    expect(found).not.toContain("ignored.txt");
    expect(found).not.toContain("built/bundle.js");
  });

  it("includes a file that is untracked but not ignored", async () => {
    write(repo, "src/brand-new.ts");
    const { found } = await collect(repo);
    // A file written a minute ago is still a file in the project.
    expect(found).toContain("src/brand-new.ts");
  });

  it("reports an exhausted budget rather than a silent truncation", async () => {
    const { result } = await collect(repo, 1);
    expect(result.complete).toBe(false);
  });

  it("reports completion when the project fits in the budget", async () => {
    const { result } = await collect(repo);
    expect(result.complete).toBe(true);
  });
});

describe("listProjectFiles outside a repository", () => {
  it("falls back to walking, still relative to the project", async () => {
    const { found, result } = await collect(plain);
    expect(found).toContain("notes/readme.md");
    expect(result.complete).toBe(true);
  });

  it("still leaves dependencies out", async () => {
    const { found } = await collect(plain);
    expect(found.some((path) => path.includes("node_modules"))).toBe(false);
  });

  it("treats a directory that does not exist as empty", async () => {
    const { found } = await collect(join(plain, "missing"));
    expect(found).toEqual([]);
  });
});
