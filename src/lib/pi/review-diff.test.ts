/**
 * Every fixture is real `git diff` output. The three shapes that carry no `@@`
 * block at all — binary, mode-change-only, rename-only — are the reason: a
 * parser written from the shape you expect drops them, and the operator then
 * sees a file git says changed and the panel says did not.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("./git", () => ({ git: vi.fn(), gitResult: vi.fn() }));

const { parseUnifiedDiff } = await import("./review-diff.ts");

const MODIFIED = `diff --git a/mod.txt b/mod.txt
index dc053e8..01ee2fc 100644
--- a/mod.txt
+++ b/mod.txt
@@ -1,2 +1,2 @@
-mod one
+mod one CHANGED
 mod two
`;

const DELETED = `diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index abaddc0..0000000
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-del
`;

const ADDED = `diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..d5a09df
--- /dev/null
+++ b/new.txt
@@ -0,0 +1 @@
+brand new
`;

const MODE_ONLY = `diff --git a/keep.txt b/keep.txt
old mode 100644
new mode 100755
`;

const BINARY = `diff --git a/b.bin b/b.bin
index 6772730..3fa429c 100644
Binary files a/b.bin and b/b.bin differ
`;

const NO_NEWLINE = `diff --git a/nonl.txt b/nonl.txt
index 1b32298..a12befd 100644
--- a/nonl.txt
+++ b/nonl.txt
@@ -1,2 +1,2 @@
 x
-y
\\ No newline at end of file
+yy
\\ No newline at end of file
`;

describe("parseUnifiedDiff", () => {
  it("reads a modification's hunk and line numbers", () => {
    const [file] = parseUnifiedDiff(MODIFIED);

    expect(file.path).toBe("mod.txt");
    expect(file.hunks).toHaveLength(1);
    expect(file.hunks[0]).toMatchObject({
      index: 0,
      newLines: 2,
      newStart: 1,
      oldLines: 2,
      oldStart: 1,
    });
    expect(file.hunks[0].lines).toEqual([
      expect.objectContaining({ kind: "removed", oldLine: 1, text: "mod one" }),
      expect.objectContaining({
        kind: "added",
        newLine: 1,
        text: "mod one CHANGED",
      }),
      expect.objectContaining({ kind: "context", newLine: 2, oldLine: 2 }),
    ]);
  });

  it("colours only the appended words of a rewritten line", () => {
    const [file] = parseUnifiedDiff(MODIFIED);
    const added = file.hunks[0].lines.find((line) => line.kind === "added")!;

    expect(
      added.spans.map((span) => added.text.slice(span.start, span.end)),
    ).toEqual([" CHANGED"]);
  });

  it("names a deleted file by its pre-image, since there is no +++ path", () => {
    const [file] = parseUnifiedDiff(DELETED);
    expect(file.path).toBe("gone.txt");
    expect(file.hunks[0].lines[0]).toMatchObject({ kind: "removed" });
  });

  it("reads a hunk header with no counts as one line each", () => {
    // "@@ -1 +0,0 @@" — git omits the count when it is 1.
    expect(parseUnifiedDiff(DELETED)[0].hunks[0]).toMatchObject({
      oldLines: 1,
      oldStart: 1,
    });
  });

  it("reads an added file and gives its lines no old numbers", () => {
    const [file] = parseUnifiedDiff(ADDED);
    expect(file.path).toBe("new.txt");
    expect(file.oldPath).toBeNull();
    expect(file.hunks[0].lines).toEqual([
      expect.objectContaining({ kind: "added", newLine: 1, oldLine: null }),
    ]);
  });

  it("keeps a mode change that has no hunks at all", () => {
    const [file] = parseUnifiedDiff(MODE_ONLY);
    expect(file).toMatchObject({
      binary: false,
      hunks: [],
      modeChangeOnly: true,
      path: "keep.txt",
    });
  });

  it("keeps a binary file, and does not call it a mode change", () => {
    const [file] = parseUnifiedDiff(BINARY);
    expect(file).toMatchObject({
      binary: true,
      hunks: [],
      modeChangeOnly: false,
      path: "b.bin",
    });
  });

  it("records the no-newline marker against the line it follows", () => {
    // It has to survive into any patch built from this hunk, or `git apply`
    // rejects the patch outright.
    const [file] = parseUnifiedDiff(NO_NEWLINE);
    const lines = file.hunks[0].lines;

    expect(lines.map((line) => [line.kind, line.noNewline])).toEqual([
      ["context", false],
      ["removed", true],
      ["added", true],
    ]);
  });

  it("keeps the header verbatim, because a rebuilt patch needs it back", () => {
    const [file] = parseUnifiedDiff(MODIFIED);
    expect(file.header).toBe(
      [
        "diff --git a/mod.txt b/mod.txt",
        "index dc053e8..01ee2fc 100644",
        "--- a/mod.txt",
        "+++ b/mod.txt",
      ].join("\n"),
    );
  });

  it("separates several files in one diff", () => {
    const files = parseUnifiedDiff(`${DELETED}${MODIFIED}${BINARY}`);
    expect(files.map((file) => file.path)).toEqual([
      "gone.txt",
      "mod.txt",
      "b.bin",
    ]);
  });

  it("numbers hunks within a file from zero, in order", () => {
    const twoHunks = `diff --git a/f.ts b/f.ts
index 1111111..2222222 100644
--- a/f.ts
+++ b/f.ts
@@ -1,3 +1,3 @@
 a
-b
+B
@@ -20,3 +20,3 @@ function tail() {
 y
-z
+Z
`;
    const [file] = parseUnifiedDiff(twoHunks);
    expect(file.hunks.map((hunk) => [hunk.index, hunk.oldStart])).toEqual([
      [0, 1],
      [1, 20],
    ]);
    expect(file.hunks[1].heading).toBe("function tail() {");
  });

  it("does not mistake diff-like file content for structure", () => {
    // A test fixture that contains a diff: every line still carries its
    // +/-/space marker, so nothing here is a header.
    const nested = `diff --git a/fixture.ts b/fixture.ts
index 1111111..2222222 100644
--- a/fixture.ts
+++ b/fixture.ts
@@ -1,4 +1,4 @@
 const patch = \`
-@@ -1,2 +1,2 @@
+@@ -1,3 +1,3 @@
 \`;
`;
    const [file] = parseUnifiedDiff(nested);
    expect(file.hunks).toHaveLength(1);
    expect(file.hunks[0].lines).toHaveLength(4);
  });

  it("reads nothing from no diff", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });
});
