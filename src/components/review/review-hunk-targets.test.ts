/**
 * The staging hunks against real git, split and staged the way the editor
 * does it.
 *
 * What this guards is the failure the operator saw: stage one part of a split
 * hunk, and the editor then drew the *whole* hunk as a single bracket, in
 * whichever direction a loose range match happened to land. The assertions
 * are about what the editor would draw after the refetch — one bracket per
 * side of the index, each over its own lines of the worktree.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { buildPatch } from "@/lib/pi/review/review-patch";
import { readFileDiff } from "@/lib/pi/review/review-diff";
import { pruneSplits, validSplitKeys } from "@/lib/pi/review/review-split-store";
import { splitKey } from "@/lib/review/review-split-key";
import type { Hunk } from "@/lib/review/review-types";

import { hunkChangedLineRange } from "./review-decorations";
import { applySplits, splitBoundaries } from "./review-hunk-splits";
import { indexLineToWorktree, stagingTargets } from "./review-hunk-targets";

let repo: string;

const run = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" });

const lines = (count: number) =>
  Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

const stage = (patch: string) =>
  execFileSync("git", ["apply", "--cached", "--unidiff-zero", "-"], {
    cwd: repo,
    encoding: "utf8",
    input: patch,
  });

const readStaging = async () => ({
  staged: await readFileDiff(repo, "f.txt", "staged"),
  unstaged: await readFileDiff(repo, "f.txt", "index"),
});

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "semla-targets-"));
  run("init", "-q", ".");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test");
  run("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "f.txt"), lines(20));
  run("add", "-A");
  run("commit", "-qm", "initial");
});

describe("stagingTargets after staging one part of a split hunk", () => {
  it("draws the staged part and the unstaged rest separately", async () => {
    // One line replaced: `-line 10` / `+CHANGED`, three context either side.
    writeFileSync(join(repo, "f.txt"), lines(20).replace("line 10\n", "CHANGED\n"));

    const before = await readStaging();
    const [only] = stagingTargets(before);
    expect(only.direction).toBe("stage");

    // The one cut on offer is between the removal and the addition.
    expect(splitBoundaries([only.display]).map((entry) => entry.boundary)).toEqual([4]);
    stage(buildPatch(before.unstaged!, [{ index: only.hunk.index, range: [0, 4] }])!);

    const targets = stagingTargets(await readStaging());
    expect(targets.map((target) => target.direction)).toEqual(["stage", "unstage"]);

    const [unstaged, staged] = targets;
    expect(unstaged.hunk.lines.filter((line) => line.kind !== "context")).toMatchObject([
      { kind: "added", text: "CHANGED" },
    ]);
    expect(staged.hunk.lines.filter((line) => line.kind !== "context")).toMatchObject([
      { kind: "removed", text: "line 10" },
    ]);

    // The addition is worktree line 10. The staged removal's surviving
    // context lines are placed on the worktree's numbering, not the
    // index's: index line 10 ("line 11") is worktree line 11.
    expect(hunkChangedLineRange(unstaged.display)).toEqual({ end: 10, start: 10 });
    const context = staged.display.lines
      .filter((line) => line.kind === "context")
      .map((line) => [line.text, line.newLine]);
    expect(context).toEqual([
      ["line 7", 7],
      ["line 8", 8],
      ["line 9", 9],
      ["line 11", 11],
      ["line 12", 12],
      ["line 13", 13],
    ]);
  });

  it("keeps a split's offsets valid against the hunk the selector addresses", async () => {
    // Two edits in one hunk, the second staged: the staged hunk sits below an
    // unstaged one that adds lines, so its worktree lines are shifted.
    writeFileSync(
      join(repo, "f.txt"),
      lines(20)
        .replace("line 4\n", "line 4\nextra a\nextra b\n")
        .replace("line 9\n", "line 9 CHANGED\n"),
    );

    const before = await readStaging();
    const [whole] = stagingTargets(before);
    const parts = applySplits(whole.display, [6]);
    // Parts tile the hunk, so the second part's range starts at the first's length.
    const second = { index: whole.hunk.index, range: [parts[0].lines.length, whole.hunk.lines.length] as const };
    stage(buildPatch(before.unstaged!, [second])!);

    const after = await readStaging();
    const staged = stagingTargets(after).find((target) => target.direction === "unstage")!;
    // In the index "line 9 CHANGED" is line 9; in the worktree, two lines
    // were added above it and are not staged, so it is line 11.
    expect(hunkChangedLineRange(staged.display)).toEqual({ end: 11, start: 11 });
    expect(staged.display.lines).toHaveLength(staged.hunk.lines.length);
  });
});

describe("splitKey across a refetch", () => {
  it("retires when part of its own hunk is staged, even at the same range", async () => {
    writeFileSync(join(repo, "f.txt"), lines(20).replace("line 10\n", "CHANGED\n"));

    const before = await readStaging();
    const [whole] = stagingTargets(before);
    stage(buildPatch(before.unstaged!, [{ index: whole.hunk.index, range: [0, 4] }])!);

    const [rest] = stagingTargets(await readStaging());
    // The premise: staging the removal left the worktree span untouched.
    expect([rest.hunk.newStart, rest.hunk.newLines]).toEqual([
      whole.hunk.newStart,
      whole.hunk.newLines,
    ]);
    expect(splitKey("stage", rest.hunk)).not.toBe(splitKey("stage", whole.hunk));
  });

  it("survives staging a sibling hunk, which shifts its index side", async () => {
    writeFileSync(
      join(repo, "f.txt"),
      lines(20)
        .replace("line 2\n", "line 2\nextra\n")
        .replace("line 18\n", "line 18 CHANGED\n"),
    );

    const before = await readStaging();
    const [first, second] = stagingTargets(before);
    stage(buildPatch(before.unstaged!, [first.hunk.index])!);

    const [remaining] = stagingTargets(await readStaging());
    expect(remaining.hunk.oldStart).not.toBe(second.hunk.oldStart);
    expect(splitKey("stage", remaining.hunk)).toBe(splitKey("stage", second.hunk));
  });

  it("is pruned from the store once staging retires it, and kept otherwise", async () => {
    writeFileSync(
      join(repo, "f.txt"),
      lines(20)
        .replace("line 2\n", "line 2\nextra\n")
        .replace("line 18\n", "line 18 CHANGED\n"),
    );

    const before = await readStaging();
    const [first, second] = stagingTargets(before);
    const stored = {
      [splitKey("stage", first.hunk)]: [2],
      [splitKey("stage", second.hunk)]: [4],
    };
    stage(buildPatch(before.unstaged!, [first.hunk.index])!);

    expect(pruneSplits(stored, validSplitKeys(await readStaging()))).toEqual({
      [splitKey("stage", second.hunk)]: [4],
    });
  });
});

describe("indexLineToWorktree", () => {
  const hunk = (partial: Partial<Hunk> & Pick<Hunk, "lines">): Hunk => ({
    heading: "",
    index: 0,
    newLines: 0,
    newStart: 0,
    oldLines: 0,
    oldStart: 0,
    ...partial,
  });
  const line = (kind: "context" | "added" | "removed", oldLine: number | null, newLine: number | null) => ({
    kind,
    newLine,
    noNewline: false,
    oldLine,
    spans: [],
    text: "",
  });

  // Index lines 5-6 become worktree 5-7: index 6 is removed, two lines added.
  const unstaged = [
    hunk({
      lines: [
        line("context", 5, 5),
        line("removed", 6, null),
        line("added", null, 6),
        line("added", null, 7),
      ],
      newLines: 3,
      newStart: 5,
      oldLines: 2,
      oldStart: 5,
    }),
  ];

  it("leaves lines above every unstaged hunk alone", () => {
    expect(indexLineToWorktree(3, unstaged)).toBe(3);
  });

  it("reads a line inside a hunk off that hunk", () => {
    expect(indexLineToWorktree(5, unstaged)).toBe(5);
    expect(indexLineToWorktree(6, unstaged)).toBeNull();
  });

  it("shifts lines below by the net change above them", () => {
    expect(indexLineToWorktree(7, unstaged)).toBe(8);
  });

  it("is the identity when nothing is unstaged", () => {
    expect(indexLineToWorktree(12, [])).toBe(12);
  });
});
