/**
 * The readers against real git, in a real repository.
 *
 * review-status.test.ts and review-diff.test.ts pin the parsers to captured
 * output, which proves they read *that* text correctly. It does not prove the
 * text is what git emits for the case it claims to cover — a fixture can be
 * wrong in exactly the way the parser is. This builds the situations instead
 * and asks git, so the two claims are independent.
 *
 * The same argument as branch-integration.test.ts: some claims are only
 * provable by doing it.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readFileDiff, readFileDiffSet, readUntrackedDiff } from "./review-diff.ts";
import { readChangedFiles, readHeadSha, readTurnCommits } from "./review-status.ts";

let repo: string;
let initialSha: string;

const run = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

const write = (name: string, body: string) =>
  writeFileSync(join(repo, name), body);

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "semla-review-"));
  run("init", "-q", ".");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test");
  run("config", "commit.gpgsign", "false");

  write("keep.txt", "a\nb\nc\n");
  write("mod.ts", "const status = readGitStatus(projectPath);\nconst other = 1;\n");
  write("gone.txt", "del\n");
  write("ren.txt", "one\ntwo\n");
  write("mode.sh", "echo hi\n");
  write("swapped.txt", "a regular file\n");
  run("add", "-A");
  run("commit", "-qm", "initial");
  initialSha = run("rev-parse", "HEAD");

  // One of every case the panel has to render.
  write("mod.ts", "const status = readGitStatus(absolutePath);\nconst other = 1;\n");
  rmSync(join(repo, "gone.txt"));
  run("mv", "ren.txt", "renamed.txt");
  write("untracked.ts", "export const fresh = true;\n");
  write("has space.txt", "spaced\n");
  write("ünïcode.txt", "unicode\n");
  write("staged.ts", "export const staged = 1;\n");
  run("add", "staged.ts");
  chmodSync(join(repo, "mode.sh"), 0o755);
  // A genuine type change: the file becomes a symlink. This is what porcelain
  // means by T, and it is not what a permission change means.
  rmSync(join(repo, "swapped.txt"));
  symlinkSync("keep.txt", join(repo, "swapped.txt"));
});

afterAll(() => {
  rmSync(repo, { force: true, recursive: true });
});

describe("readChangedFiles against real git", () => {
  it("sees every kind of change, however it was made", async () => {
    const { files } = await readChangedFiles(repo);
    const byPath = new Map(files.map((file) => [file.path, file]));

    expect(byPath.get("mod.ts")?.status).toBe("modified");
    expect(byPath.get("gone.txt")?.status).toBe("deleted");
    expect(byPath.get("renamed.txt")?.status).toBe("renamed");
    expect(byPath.get("untracked.ts")?.status).toBe("untracked");
    expect(byPath.get("staged.ts")?.status).toBe("added");
    // A permission change is a modification to porcelain, not a T — and it
    // still produces a diff with no hunks, which is why the diff parser has
    // to keep a hunkless file rather than drop it.
    expect(byPath.get("mode.sh")?.status).toBe("modified");
    expect(byPath.get("swapped.txt")?.status).toBe("type-changed");
  });

  it("reads a rename's original path from the right field", async () => {
    // The whole reason -z is used and the reason this test exists: the two
    // porcelain formats order these two paths oppositely.
    const { files } = await readChangedFiles(repo);
    const rename = files.find((file) => file.status === "renamed");

    expect(rename?.path).toBe("renamed.txt");
    expect(rename?.oldPath).toBe("ren.txt");
  });

  it("returns paths with spaces and non-ASCII bytes usable as-is", async () => {
    const { files } = await readChangedFiles(repo);
    const paths = files.map((file) => file.path);

    expect(paths).toContain("has space.txt");
    expect(paths).toContain("ünïcode.txt");

    // The real proof: the path git gave back can be handed straight to a diff.
    const diff = await readUntrackedDiff(repo, "has space.txt");
    expect(diff?.hunks[0].lines[0].text).toBe("spaced");
  });

  it("distinguishes what a commit would include from what it would not", async () => {
    const { files } = await readChangedFiles(repo);
    const byPath = new Map(files.map((file) => [file.path, file]));

    expect(byPath.get("staged.ts")).toMatchObject({ staged: true });
    expect(byPath.get("mod.ts")).toMatchObject({ staged: false, unstaged: true });
  });

  it("says nothing changed in a clean repository", async () => {
    const clean = mkdtempSync(join(tmpdir(), "semla-clean-"));
    execFileSync("git", ["init", "-q", "."], { cwd: clean });
    try {
      expect(await readChangedFiles(clean)).toEqual({ files: [], omitted: 0 });
    } finally {
      rmSync(clean, { force: true, recursive: true });
    }
  });

  it("reports nothing at all outside a repository, rather than throwing", async () => {
    const plain = mkdtempSync(join(tmpdir(), "semla-plain-"));
    try {
      expect(await readChangedFiles(plain)).toEqual({ files: [], omitted: 0 });
      expect(await readHeadSha(plain)).toBeNull();
    } finally {
      rmSync(plain, { force: true, recursive: true });
    }
  });
});

describe("readFileDiffSet against real git", () => {
  it("colours the argument that changed and nothing around it", async () => {
    const set = await readFileDiffSet(repo, "mod.ts");
    const added = set.full?.hunks[0].lines.find((line) => line.kind === "added");

    expect(added?.text).toBe("const status = readGitStatus(absolutePath);");
    expect(
      added?.spans.map((span) => added.text.slice(span.start, span.end)),
    ).toEqual(["absolute"]);
  });

  it("separates the whole change from what is staged", async () => {
    // mod.ts is modified but not staged: full has a hunk, staged has nothing.
    const set = await readFileDiffSet(repo, "mod.ts");
    expect(set.full?.hunks).toHaveLength(1);
    expect(set.staged).toBeNull();
    expect(set.unstaged?.hunks).toHaveLength(1);
  });

  it("reads a staged addition as staged and not as unstaged", async () => {
    const set = await readFileDiffSet(repo, "staged.ts");
    expect(set.staged?.hunks).toHaveLength(1);
    expect(set.unstaged).toBeNull();
  });

  it("synthesizes an untracked file's diff without touching the index", async () => {
    const before = run("status", "--porcelain=v1");
    const set = await readFileDiffSet(repo, "untracked.ts", { untracked: true });

    expect(set.untracked).toBe(true);
    expect(set.full?.hunks[0].lines).toEqual([
      expect.objectContaining({ kind: "added", text: "export const fresh = true;" }),
    ]);
    expect(set.staged).toBeNull();
    // The index is exactly as it was: no `git add -N` happened behind the scenes.
    expect(run("status", "--porcelain=v1")).toBe(before);
  });

  it("keeps a mode change, which carries no hunks at all", async () => {
    const diff = await readFileDiff(repo, "mode.sh", "head");
    expect(diff).toMatchObject({ hunks: [], modeChangeOnly: true, path: "mode.sh" });
  });

  it("reads a deletion as a removed line, not as an empty diff", async () => {
    const diff = await readFileDiff(repo, "gone.txt", "head");
    expect(diff?.hunks[0].lines).toEqual([
      expect.objectContaining({ kind: "removed", text: "del" }),
    ]);
  });
});

describe("readTurnCommits against real git", () => {
  it("lists what was committed since the mark, newest first", async () => {
    run("add", "-A");
    run("commit", "-qm", "[Review]: agent commit one");
    write("keep.txt", "a\nb\nc\nd\n");
    run("add", "-A");
    run("commit", "-qm", "[Review]: agent commit two");

    const commits = await readTurnCommits(repo, initialSha);

    expect(commits.map((commit) => commit.subject)).toEqual([
      "[Review]: agent commit two",
      "[Review]: agent commit one",
    ]);
    expect(commits[0].fileCount).toBe(1);
    expect(commits[0].author).toBe("Test");
  });

  it("has no range without a mark", async () => {
    expect(await readTurnCommits(repo, null)).toEqual([]);
  });

  it("refuses a sha that is not an ancestor of HEAD", async () => {
    // A detached, unrelated commit: `start..HEAD` would describe a set of
    // commits that has nothing to do with the turn.
    const orphan = run("commit-tree", run("rev-parse", "HEAD^{tree}"), "-m", "orphan");
    expect(await readTurnCommits(repo, orphan)).toEqual([]);
  });
});
