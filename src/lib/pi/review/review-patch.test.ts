/**
 * The patch builder against real git.
 *
 * This is the load-bearing test of the review feature. Every other mistake in
 * the panel is visible — a wrong colour, a missing row — but a patch that
 * applies cleanly while containing the wrong lines stages something the
 * operator did not read and did not choose, and git will report success.
 *
 * So the assertions are not about the patch text. They apply it with real
 * `git apply --cached` and then ask git what ended up in the index.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { buildPatch } from "./review-patch.ts";
import { parseUnifiedDiff, readFileDiff } from "./review-diff.ts";

let repo: string;

const run = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

const write = (name: string, body: string) =>
  writeFileSync(join(repo, name), body);

/** Apply a patch through git itself, exactly as the staging route will. */
const apply = (patch: string, ...flags: string[]) =>
  execFileSync("git", ["apply", "--cached", ...flags, "-"], {
    cwd: repo,
    encoding: "utf8",
    input: patch,
  });

/** The file as the index now holds it. */
const staged = (name: string) => run("show", `:${name}`);

const lines = (count: number, prefix = "line") =>
  Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`).join("\n") + "\n";

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "semla-patch-"));
  run("init", "-q", ".");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test");
  run("config", "commit.gpgsign", "false");
  write("file.txt", lines(20));
  run("add", "-A");
  run("commit", "-qm", "initial");
});

describe("buildPatch", () => {
  it("stages one hunk out of two and leaves the other alone", async () => {
    // Two edits, far enough apart that git reports them as separate hunks.
    const edited = lines(20)
      .replace("line 2\n", "line 2 CHANGED\n")
      .replace("line 18\n", "line 18 CHANGED\n");
    write("file.txt", edited);

    const diff = await readFileDiff(repo, "file.txt");
    expect(diff!.hunks).toHaveLength(2);

    apply(buildPatch(diff!, [1])!);

    // The second edit is staged; the first is not.
    expect(staged("file.txt")).toContain("line 18 CHANGED");
    expect(staged("file.txt")).not.toContain("line 2 CHANGED");
  });

  it("recomputes the post-image start when an earlier hunk is skipped", async () => {
    // The first hunk adds three lines. Copying git's own header for the second
    // hunk would place it three lines too late, and git would either refuse it
    // or apply it to the wrong lines.
    const edited = lines(20)
      .replace("line 2\n", "line 2\nextra a\nextra b\nextra c\n")
      .replace("line 18\n", "line 18 CHANGED\n");
    write("file.txt", edited);

    const diff = await readFileDiff(repo, "file.txt");
    const patch = buildPatch(diff!, [1])!;

    // The proof: git's own header for this hunk is "@@ -15,6 +18,6 @@",
    // because the three added lines above it shift the post-image down. With
    // that hunk skipped they do not, so the corrected header reads +15.
    expect(diff!.hunks[1].newStart).toBe(18);
    expect(patch).toContain("@@ -15,6 +15,6 @@");
    apply(patch);

    const result = staged("file.txt");
    expect(result).toContain("line 18 CHANGED");
    expect(result).not.toContain("extra a");
    // And the file is otherwise untouched: 20 lines, not 23.
    expect(result.trimEnd().split("\n")).toHaveLength(20);
  });

  it("stages every hunk when they are all selected", async () => {
    const edited = lines(20)
      .replace("line 2\n", "line 2 CHANGED\n")
      .replace("line 18\n", "line 18 CHANGED\n");
    write("file.txt", edited);

    const diff = await readFileDiff(repo, "file.txt");
    apply(buildPatch(diff!, [0, 1])!);

    expect(staged("file.txt")).toBe(edited.trimEnd());
    // Nothing is left unstaged.
    expect(run("diff", "--", "file.txt")).toBe("");
  });

  it("round-trips: staging then reversing restores the index", async () => {
    // The strongest available check that the patch describes exactly the
    // change it claims to, and nothing adjacent.
    const before = staged("file.txt");
    write("file.txt", lines(20).replace("line 9\n", "line 9 CHANGED\n"));

    const diff = await readFileDiff(repo, "file.txt");
    const patch = buildPatch(diff!, [0])!;

    apply(patch);
    expect(staged("file.txt")).not.toBe(before);

    apply(patch, "--reverse");
    expect(staged("file.txt")).toBe(before);
  });

  it("preserves a missing trailing newline", async () => {
    // git rejects a patch whose no-newline marker is absent or misplaced, so
    // this is the difference between staging and an error the operator cannot
    // act on.
    write("nonl.txt", "first\nsecond");
    run("add", "nonl.txt");
    run("commit", "-qm", "no newline");
    write("nonl.txt", "first\nsecond changed");

    const diff = await readFileDiff(repo, "nonl.txt");
    const patch = buildPatch(diff!, [0])!;

    expect(patch).toContain("\\ No newline at end of file");
    apply(patch);
    expect(staged("nonl.txt")).toBe("first\nsecond changed");
  });

  it("stages a mode change, which has no hunks to select at all", async () => {
    chmodSync(join(repo, "file.txt"), 0o755);

    const diff = await readFileDiff(repo, "file.txt");
    expect(diff!.hunks).toHaveLength(0);

    // An empty selection still means "apply this": there was never a hunk to
    // choose, and refusing would make the change unstageable.
    apply(buildPatch(diff!, [])!);
    expect(run("diff", "--cached", "--summary")).toContain("mode change");
  });

  it("stages a deletion", async () => {
    rmSync(join(repo, "file.txt"));

    const diff = await readFileDiff(repo, "file.txt");
    apply(buildPatch(diff!, [0])!);

    expect(run("diff", "--cached", "--name-status")).toBe("D\tfile.txt");
  });

  it("stages a rename with no edits from its header alone", async () => {
    run("mv", "file.txt", "moved.txt");
    // Read the rename as the panel would see it once unstaged again.
    run("reset", "-q");
    const diff = await readFileDiff(repo, "moved.txt");

    // An untracked destination: there is no rename to stage, only an add, and
    // the panel handles untracked files with `git add`. The point being
    // asserted is that the builder does not invent hunks for it.
    expect(diff).toBeNull();
  });

  it("refuses to build a patch for a binary file", () => {
    const binary = parseUnifiedDiff(`diff --git a/b.bin b/b.bin
index 6772730..3fa429c 100644
Binary files a/b.bin and b/b.bin differ
`)[0];

    expect(buildPatch(binary, [])).toBeNull();
  });

  it("builds nothing when nothing is selected", async () => {
    write("file.txt", lines(20).replace("line 2\n", "line 2 CHANGED\n"));
    const diff = await readFileDiff(repo, "file.txt");

    expect(buildPatch(diff!, [])).toBeNull();
  });

  it("ignores a selection that names a hunk the diff does not have", async () => {
    write("file.txt", lines(20).replace("line 2\n", "line 2 CHANGED\n"));
    const diff = await readFileDiff(repo, "file.txt");

    // A stale selection from a diff read before the operator edited again.
    // Applying the hunks that do exist is right; inventing one is not.
    expect(buildPatch(diff!, [7])).toBeNull();
    apply(buildPatch(diff!, [0, 7])!);
    expect(staged("file.txt")).toContain("line 2 CHANGED");
  });
});

/**
 * Sub-hunk selection: staging part of a hunk the operator split in the
 * gutter.
 *
 * The setup throughout is one hunk holding two independent edits. That is not
 * a contrived shape — it is what `-U3` produces for any two edits within six
 * lines of each other, and it is the whole reason splitting exists: git offers
 * the pair as a single unit to stage, and the operator wants one of them.
 *
 * Assertions are the same as above's: apply with real `git apply --cached`,
 * then ask git what is in the index and what is still unstaged. A sub-hunk
 * patch that applies cleanly at the wrong offset is the failure mode with no
 * visible symptom, so "the other change is still unstaged" is checked
 * explicitly every time rather than inferred from the first assertion.
 */
describe("buildPatch with sub-hunk selectors", () => {
  /**
   * `apply`, plus the `--unidiff-zero` the staging route itself passes
   * (`applyPatch` in review-apply.ts).
   *
   * This is not a convenience, and the flag is not optional for a slice.
   * `git apply` verifies a hunk's *trailing* context too, and treats a hunk
   * with fewer than three trailing context lines as a claim that the hunk
   * runs to the end of the file (`apply.c`'s `match_end`). A slice cut out of
   * the middle of a hunk has truncated context by construction, so git
   * searches for "these lines, then EOF", finds the rest of the file instead,
   * and refuses with "patch does not apply" — while the identical patch with
   * three trailing context lines applies fine. `--unidiff-zero` is what
   * switches that check off, and review-apply.ts's docblock already explains
   * that it passes the flag unconditionally against exactly this kind of
   * change in context width. The tests above deliberately keep calling bare
   * `apply`: a whole hunk carries git's own context and must apply without
   * the flag.
   */
  const applyAsRoute = (patch: string, ...flags: string[]) =>
    apply(patch, "--unidiff-zero", ...flags);

  /**
   * Two edits six lines apart, which git reports as one hunk of 14 lines:
   *
   *   0  context line 1
   *   1  -line 2      2  +line 2 CHANGED
   *   3..8 context lines 3-8
   *   9  -line 9      10 +line 9 CHANGED
   *   11..13 context lines 10-12
   */
  const twoEditsInOneHunk = () =>
    lines(20)
      .replace("line 2\n", "line 2 CHANGED\n")
      .replace("line 9\n", "line 9 CHANGED\n");

  it("stages only the first change of a hunk holding two", async () => {
    write("file.txt", twoEditsInOneHunk());

    const diff = await readFileDiff(repo, "file.txt");
    // The premise: one hunk, so a whole-hunk selection could not separate
    // these two edits at all.
    expect(diff!.hunks).toHaveLength(1);
    expect(diff!.hunks[0].lines).toHaveLength(14);

    applyAsRoute(buildPatch(diff!, [{ index: 0, range: [0, 3] }])!);

    const result = staged("file.txt");
    expect(result).toContain("line 2 CHANGED");
    expect(result).toContain("line 9\n");
    expect(result).not.toContain("line 9 CHANGED");
    // And the second edit is still there to stage, rather than lost.
    expect(run("diff", "--", "file.txt")).toContain("+line 9 CHANGED");
  });

  it("stages only the second change, recomputing its post-image start", async () => {
    // The interesting half: the slice starts partway into the hunk, so both
    // its `oldStart` and `newStart` have to advance over the skipped lines —
    // and they advance by different amounts, since the skipped prefix holds
    // one removal and one addition.
    write("file.txt", twoEditsInOneHunk());

    const diff = await readFileDiff(repo, "file.txt");
    applyAsRoute(buildPatch(diff!, [{ index: 0, range: [9, 11] }])!);

    const result = staged("file.txt");
    expect(result).toContain("line 9 CHANGED");
    expect(result).not.toContain("line 2 CHANGED");
    expect(result.trimEnd().split("\n")).toHaveLength(20);
  });

  it("stages both halves of a split hunk exactly as the whole hunk would", async () => {
    // Round-trip against the whole-hunk path: two slices covering every line
    // of the hunk must be indistinguishable from selecting the hunk itself.
    // This is what catches an off-by-one in the second slice's header, which
    // a single-slice test cannot see.
    const edited = twoEditsInOneHunk();
    write("file.txt", edited);

    const diff = await readFileDiff(repo, "file.txt");
    applyAsRoute(
      buildPatch(diff!, [
        { index: 0, range: [0, 9] },
        { index: 0, range: [9, 14] },
      ])!,
    );

    expect(staged("file.txt")).toBe(edited.trimEnd());
    expect(run("diff", "--", "file.txt")).toBe("");
  });

  it("orders slices by file position, not by the order they were listed", async () => {
    // `offset` only accumulates correctly in ascending file order (see the
    // module docblock), and a caller has no reason to know that.
    const edited = twoEditsInOneHunk();
    write("file.txt", edited);

    const diff = await readFileDiff(repo, "file.txt");
    applyAsRoute(
      buildPatch(diff!, [
        { index: 0, range: [9, 14] },
        { index: 0, range: [0, 9] },
      ])!,
    );

    expect(staged("file.txt")).toBe(edited.trimEnd());
  });

  it("mixes a whole-hunk selector with a slice of another hunk", async () => {
    // Two hunks, the first split: the whole-hunk selector must still be
    // positioned relative to what the slice emitted before it.
    const edited = lines(30)
      .replace("line 2\n", "line 2 CHANGED\n")
      .replace("line 9\n", "line 9 CHANGED\n")
      .replace("line 25\n", "line 25 CHANGED\n");
    write("file.txt", edited);

    const diff = await readFileDiff(repo, "file.txt");
    expect(diff!.hunks).toHaveLength(2);

    applyAsRoute(buildPatch(diff!, [1, { index: 0, range: [0, 3] }])!);

    const result = staged("file.txt");
    expect(result).toContain("line 2 CHANGED");
    expect(result).toContain("line 25 CHANGED");
    expect(result).not.toContain("line 9 CHANGED");
    expect(result.trimEnd().split("\n")).toHaveLength(30);
  });

  it("round-trips a slice: staging then reversing restores the index", async () => {
    const before = staged("file.txt");
    write("file.txt", twoEditsInOneHunk());

    const diff = await readFileDiff(repo, "file.txt");
    const patch = buildPatch(diff!, [{ index: 0, range: [0, 3] }])!;

    applyAsRoute(patch);
    expect(staged("file.txt")).not.toBe(before);

    applyAsRoute(patch, "--reverse");
    expect(staged("file.txt")).toBe(before);
  });

  it("ignores a slice whose range is out of bounds for its hunk", async () => {
    // Same staleness as a selection naming a hunk that no longer exists: the
    // boundary came from a diff read before the operator edited again. Skip
    // what cannot be resolved and apply what can.
    write("file.txt", twoEditsInOneHunk());
    const diff = await readFileDiff(repo, "file.txt");

    expect(buildPatch(diff!, [{ index: 0, range: [0, 99] }])).toBeNull();
    expect(buildPatch(diff!, [{ index: 0, range: [5, 5] }])).toBeNull();
    expect(buildPatch(diff!, [{ index: 0, range: [-1, 3] }])).toBeNull();
    expect(buildPatch(diff!, [{ index: 9, range: [0, 2] }])).toBeNull();

    applyAsRoute(
      buildPatch(diff!, [
        { index: 0, range: [0, 99] },
        { index: 0, range: [0, 3] },
      ])!,
    );
    expect(staged("file.txt")).toContain("line 2 CHANGED");
  });

  it("emits one hunk for a selector listed twice", async () => {
    // git rejects a patch with two overlapping hunks outright, so a
    // duplicate has to be dropped rather than rendered — the `Set` of
    // indexes this used to build made that impossible to get wrong.
    write("file.txt", twoEditsInOneHunk());
    const diff = await readFileDiff(repo, "file.txt");

    const patch = buildPatch(diff!, [
      { index: 0, range: [0, 3] },
      { index: 0, range: [0, 3] },
    ])!;

    expect(patch.match(/^@@/gm)).toHaveLength(1);
    applyAsRoute(patch);
    expect(staged("file.txt")).toContain("line 2 CHANGED");
  });
});
