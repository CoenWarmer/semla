import { describe, expect, it } from "vitest";

import { parseUnifiedDiff } from "@/lib/pi/review-diff";

import { buildDecorations, firstChangedLine } from "./review-decorations.ts";

/** Parse real diff text so the hunks under test are the ones git produces. */
const hunksOf = (diff: string) => parseUnifiedDiff(diff)[0].hunks;

const REPLACED = hunksOf(`diff --git a/f.ts b/f.ts
index 1111111..2222222 100644
--- a/f.ts
+++ b/f.ts
@@ -1,3 +1,3 @@
 const keep = 1;
-const before = 2;
+const after = 2;
 const tail = 3;
`);

const REMOVED_MIDDLE = hunksOf(`diff --git a/f.ts b/f.ts
index 1111111..2222222 100644
--- a/f.ts
+++ b/f.ts
@@ -1,4 +1,2 @@
 first
-second
-third
 fourth
`);

const REMOVED_AT_END = hunksOf(`diff --git a/f.ts b/f.ts
index 1111111..2222222 100644
--- a/f.ts
+++ b/f.ts
@@ -1,3 +1,1 @@
 first
-second
-third
`);

const PURE_ADDITION = hunksOf(`diff --git a/f.ts b/f.ts
index 1111111..2222222 100644
--- a/f.ts
+++ b/f.ts
@@ -5,2 +5,4 @@ function tail() {
 context
+added one
+added two
 more
`);

describe("buildDecorations", () => {
  it("tints the added line and the characters that differ within it", () => {
    const decorations = buildDecorations(REPLACED);

    expect(decorations).toEqual([
      expect.objectContaining({ kind: "removed-marker", startLine: 2 }),
      expect.objectContaining({
        endColumn: null,
        kind: "added-line",
        startLine: 2,
      }),
      expect.objectContaining({ kind: "added-span", startLine: 2 }),
    ]);
  });

  it("converts 0-based diff offsets to Monaco's 1-based columns", () => {
    // "const before = 2;" -> "const after = 2;". The span covers "after",
    // which starts at offset 6 and so at column 7.
    const span = buildDecorations(REPLACED).find(
      (decoration) => decoration.kind === "added-span",
    );
    expect(span).toMatchObject({ endColumn: 12, startColumn: 7 });
  });

  it("reports removed lines against the line that now holds their place", () => {
    // "second" and "third" went; "fourth" is line 2 in the new file.
    const markers = buildDecorations(REMOVED_MIDDLE).filter(
      (decoration) => decoration.kind === "removed-marker",
    );
    expect(markers).toEqual([
      expect.objectContaining({ removedCount: 2, startLine: 2 }),
    ]);
  });

  it("attaches a removal at the end of the file to the last surviving line", () => {
    // There is no following line to mark, and dropping the marker would hide
    // the deletion entirely.
    const markers = buildDecorations(REMOVED_AT_END).filter(
      (decoration) => decoration.kind === "removed-marker",
    );
    expect(markers).toEqual([
      expect.objectContaining({ removedCount: 2, startLine: 1 }),
    ]);
  });

  it("gives a wholly new line no character spans to colour", () => {
    // Nothing was replaced, so there is no counterpart to differ from and the
    // line tint already says it is new.
    const decorations = buildDecorations(PURE_ADDITION);

    expect(decorations.map((decoration) => decoration.kind)).toEqual([
      "added-line",
      "added-line",
    ]);
    expect(decorations.map((decoration) => decoration.startLine)).toEqual([6, 7]);
  });

  it("has nothing to draw for an empty diff", () => {
    expect(buildDecorations([])).toEqual([]);
  });
});

describe("firstChangedLine", () => {
  it("finds the first line that is not context", () => {
    expect(firstChangedLine(PURE_ADDITION)).toBe(6);
    expect(firstChangedLine(REPLACED)).toBe(2);
  });

  it("gives a hunk of pure removals a position anyway", () => {
    expect(firstChangedLine(REMOVED_AT_END)).toBe(1);
  });

  it("has nowhere to go in an empty diff", () => {
    expect(firstChangedLine([])).toBeNull();
  });
});
