import { describe, expect, it } from "vitest";

import { parseUnifiedDiff } from "@/lib/pi/review/review-diff";
import type {
  ChangedFile,
  FileDiff,
  ProjectReview,
} from "@/lib/review/review-types";

import {
  applyDirection,
  cursorForFile,
  cursorFilesFor,
  hunkSlots,
  initialCursor,
  moveFile,
  moveHunk,
  positionAfterApply,
  resolveSlot,
  revealAfterApply,
  type CursorFile,
  type FileDiffs,
  type HunkCursor,
} from "./review-hunk-cursor.ts";

/** Parse real diff text, so the hunks under test are the ones git produces. */
const diffOf = (diff: string): FileDiff => parseUnifiedDiff(diff)[0];

/** A file diff with `count` well-separated hunks, so git emits one `@@` each. */
function diffWithHunks(path: string, count: number): FileDiff {
  const body = Array.from({ length: count }, (_, at) => {
    const start = at * 20 + 1;
    return `@@ -${start},3 +${start},3 @@\n keep${start};\n-before${start};\n+after${start};\n`;
  }).join("");

  return diffOf(
    `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n${body}`,
  );
}

const FILES: CursorFile[] = [
  { path: "a.ts", project: "repo" },
  { path: "b.ts", project: "repo" },
  { path: "c.ts", project: "repo" },
];

const unstagedOnly = (count: number): FileDiffs => ({
  staged: null,
  unstaged: diffWithHunks("a.ts", count),
});

describe("hunkSlots", () => {
  it("lists staged hunks before unstaged ones, group-relative", () => {
    const diffs: FileDiffs = {
      staged: diffWithHunks("a.ts", 2),
      unstaged: diffWithHunks("a.ts", 3),
    };

    expect(hunkSlots(diffs)).toEqual([
      { group: "staged", index: 0 },
      { group: "staged", index: 1 },
      { group: "unstaged", index: 0 },
      { group: "unstaged", index: 1 },
      { group: "unstaged", index: 2 },
    ]);
  });

  it("is empty for a file whose diff has not loaded", () => {
    expect(hunkSlots(null)).toEqual([]);
    expect(hunkSlots({ staged: null, unstaged: null })).toEqual([]);
  });
});

describe("resolveSlot", () => {
  const slots = hunkSlots(unstagedOnly(3));

  it("resolves an edge to the first or last hunk of the file", () => {
    expect(resolveSlot(slots, { edge: "first" })).toEqual({
      group: "unstaged",
      index: 0,
    });
    expect(resolveSlot(slots, { edge: "last" })).toEqual({
      group: "unstaged",
      index: 2,
    });
  });

  it("has nothing to resolve to in a file with no hunks", () => {
    expect(resolveSlot([], { edge: "first" })).toBeNull();
    expect(resolveSlot([], { group: "unstaged", index: 0 })).toBeNull();
  });

  // Staging the last unstaged hunk leaves an address one past the end.
  it("clamps an address past the end to the last hunk of its own group", () => {
    const remaining = hunkSlots(unstagedOnly(2));
    expect(resolveSlot(remaining, { group: "unstaged", index: 2 })).toEqual({
      group: "unstaged",
      index: 1,
    });
  });

  // A stage must not become an unstage because a group emptied out.
  it("does not fall across groups when its own group is gone", () => {
    const stagedOnly = hunkSlots({
      staged: diffWithHunks("a.ts", 2),
      unstaged: null,
    });
    expect(resolveSlot(stagedOnly, { group: "unstaged", index: 0 })).toBeNull();
  });
});

describe("initialCursor", () => {
  it("starts on the selected file when it is one of the changed files", () => {
    expect(initialCursor(FILES, { path: "b.ts", project: "repo" })).toEqual({
      file: { path: "b.ts", project: "repo" },
      target: { edge: "first" },
    });
  });

  it("falls back to the first changed file", () => {
    expect(initialCursor(FILES, null)?.file.path).toBe("a.ts");
    expect(
      initialCursor(FILES, { path: "elsewhere.ts", project: "repo" })?.file
        .path,
    ).toBe("a.ts");
  });

  it("is null when nothing has changed", () => {
    expect(initialCursor([], null)).toBeNull();
  });
});

describe("moveHunk within a file", () => {
  const slots = hunkSlots(unstagedOnly(3));
  const at = (index: number): HunkCursor => ({
    file: FILES[0],
    target: { group: "unstaged", index },
  });

  it("steps forward and back", () => {
    expect(moveHunk({ cursor: at(0), delta: 1, files: FILES, slots })).toEqual(
      at(1),
    );
    expect(moveHunk({ cursor: at(2), delta: -1, files: FILES, slots })).toEqual(
      at(1),
    );
  });

  it("crosses group boundaries in order", () => {
    const mixed = hunkSlots({
      staged: diffWithHunks("a.ts", 1),
      unstaged: diffWithHunks("a.ts", 1),
    });
    const onStaged: HunkCursor = {
      file: FILES[0],
      target: { group: "staged", index: 0 },
    };
    expect(
      moveHunk({ cursor: onStaged, delta: 1, files: FILES, slots: mixed }),
    ).toEqual({ file: FILES[0], target: { group: "unstaged", index: 0 } });
  });
});

describe("moveHunk across files", () => {
  const slots = hunkSlots(unstagedOnly(2));

  it("rolls off the last hunk into the first hunk of the next file", () => {
    const last: HunkCursor = {
      file: FILES[0],
      target: { group: "unstaged", index: 1 },
    };
    expect(moveHunk({ cursor: last, delta: 1, files: FILES, slots })).toEqual({
      file: FILES[1],
      target: { edge: "first" },
    });
  });

  it("rolls off the first hunk into the last hunk of the previous file", () => {
    const first: HunkCursor = {
      file: FILES[1],
      target: { group: "unstaged", index: 0 },
    };
    expect(moveHunk({ cursor: first, delta: -1, files: FILES, slots })).toEqual({
      file: FILES[0],
      target: { edge: "last" },
    });
  });

  // A file whose hunks have not arrived still has a next file, so the walk
  // does not stall waiting for a fetch.
  it("steps through a file with no navigable hunks", () => {
    const onEmpty: HunkCursor = { file: FILES[1], target: { edge: "first" } };
    expect(
      moveHunk({ cursor: onEmpty, delta: 1, files: FILES, slots: [] }),
    ).toEqual({ file: FILES[2], target: { edge: "first" } });
  });

  it("does not wrap at either end of the whole sequence", () => {
    const veryFirst: HunkCursor = {
      file: FILES[0],
      target: { group: "unstaged", index: 0 },
    };
    expect(
      moveHunk({ cursor: veryFirst, delta: -1, files: FILES, slots }),
    ).toEqual(veryFirst);

    const veryLast: HunkCursor = {
      file: FILES[2],
      target: { group: "unstaged", index: 1 },
    };
    expect(
      moveHunk({ cursor: veryLast, delta: 1, files: FILES, slots }),
    ).toEqual(veryLast);
  });
});

describe("moveFile", () => {
  it("lands on the first hunk in both directions", () => {
    const cursor = cursorForFile(FILES[1]);
    expect(moveFile({ cursor, delta: 1, files: FILES })).toEqual({
      file: FILES[2],
      target: { edge: "first" },
    });
    expect(moveFile({ cursor, delta: -1, files: FILES })).toEqual({
      file: FILES[0],
      target: { edge: "first" },
    });
  });

  it("stays put at the ends of the file list", () => {
    const first = cursorForFile(FILES[0]);
    expect(moveFile({ cursor: first, delta: -1, files: FILES })).toEqual(first);
    const last = cursorForFile(FILES[2]);
    expect(moveFile({ cursor: last, delta: 1, files: FILES })).toEqual(last);
  });
});

describe("positionAfterApply", () => {
  const slots = hunkSlots(unstagedOnly(3));

  // Applying renumbers the diff, so holding the address advances the cursor.
  it("holds the applied address, which now names the following hunk", () => {
    const cursor: HunkCursor = {
      file: FILES[0],
      target: { group: "unstaged", index: 0 },
    };
    expect(
      positionAfterApply({
        applied: { group: "unstaged", index: 0 },
        cursor,
        files: FILES,
        slots,
      }),
    ).toEqual(cursor);
  });

  it("rolls into the next file when the last hunk of this one was applied", () => {
    const cursor: HunkCursor = {
      file: FILES[0],
      target: { group: "unstaged", index: 2 },
    };
    expect(
      positionAfterApply({
        applied: { group: "unstaged", index: 2 },
        cursor,
        files: FILES,
        slots,
      }),
    ).toEqual({ file: FILES[1], target: { edge: "first" } });
  });

  it("stays on the last file when there is nothing after it", () => {
    const cursor: HunkCursor = {
      file: FILES[2],
      target: { group: "unstaged", index: 2 },
    };
    expect(
      positionAfterApply({
        applied: { group: "unstaged", index: 2 },
        cursor,
        files: FILES,
        slots,
      }),
    ).toEqual(cursor);
  });
});

const changedFile = (path: string, opts: Partial<ChangedFile> = {}): ChangedFile => ({
  indexCode: " ",
  oldPath: null,
  path,
  staged: false,
  status: "modified",
  unstaged: true,
  worktreeCode: "M",
  ...opts,
});

const projectOf = (
  path: string,
  changedFiles: ChangedFile[],
): ProjectReview => ({
  changedFiles,
  headSha: "head",
  name: path,
  omitted: 0,
  otherActiveSessions: 0,
  path,
  startSha: "start",
  turnCommits: [],
});

describe("cursorFilesFor", () => {
  it("lists staged rows before unstaged ones, within each project", () => {
    const project = projectOf("repo", [
      changedFile("unstaged.ts"),
      changedFile("staged.ts", { staged: true, unstaged: false }),
    ]);

    expect(cursorFilesFor([project], null)).toEqual([
      { path: "staged.ts", project: "repo" },
      { path: "unstaged.ts", project: "repo" },
    ]);
  });

  it("lists one entry for a file that is partly staged and partly not", () => {
    // A file with `staged: true, unstaged: true` matches both filters in the
    // walk below; two entries for it would make a keyboard `s` press appear
    // to do nothing once it stepped onto the second, identical copy.
    const project = projectOf("repo", [
      changedFile("both.ts", { staged: true, unstaged: true }),
    ]);

    expect(cursorFilesFor([project], null)).toEqual([
      { path: "both.ts", project: "repo" },
    ]);
  });

  it("walks every project in order", () => {
    const first = projectOf("a", [changedFile("x.ts")]);
    const second = projectOf("b", [changedFile("y.ts")]);

    expect(cursorFilesFor([first, second], null)).toEqual([
      { path: "x.ts", project: "a" },
      { path: "y.ts", project: "b" },
    ]);
  });

  it("contributes nothing for a commit's scope, which has no index to stage into", () => {
    const project: ProjectReview = {
      ...projectOf("repo", []),
      turnCommits: [
        {
          at: "2024-01-01T00:00:00Z",
          author: "test",
          fileChanges: [{ oldPath: null, path: "committed.ts", status: "modified" }],
          fileCount: 1,
          files: ["committed.ts"],
          sha: "abc123",
          shortSha: "abc123",
          subject: "a commit",
        },
      ],
    };

    expect(cursorFilesFor([project], "abc123")).toEqual([]);
  });
});

describe("applyDirection", () => {
  it("stages an unstaged hunk and unstages a staged one", () => {
    expect(applyDirection({ group: "unstaged", index: 0 })).toBe("stage");
    expect(applyDirection({ group: "staged", index: 0 })).toBe("unstage");
  });
});

describe("revealAfterApply", () => {
  const pending = { file: FILES[0], since: 1000 };

  it("reveals once a diff newer than the staged one arrives", () => {
    expect(
      revealAfterApply({
        cursorFile: FILES[0],
        dataUpdatedAt: 1001,
        pending,
      }),
    ).toBe("reveal");
  });

  // A re-render hands back a fresh object for an unchanged answer; that is not
  // the re-fetch landing, and revealing on it would scroll to the stale line.
  it("waits while the diff is the one the stage was issued against", () => {
    expect(
      revealAfterApply({ cursorFile: FILES[0], dataUpdatedAt: 1000, pending }),
    ).toBe("wait");
  });

  it("waits when nothing is owed", () => {
    expect(
      revealAfterApply({
        cursorFile: FILES[0],
        dataUpdatedAt: 9999,
        pending: null,
      }),
    ).toBe("wait");
  });

  // Otherwise the owed reveal eventually scrolls the editor to a line in a
  // file the operator has already navigated away from.
  it("drops a reveal owed to a file the cursor has left", () => {
    expect(
      revealAfterApply({ cursorFile: FILES[1], dataUpdatedAt: 1001, pending }),
    ).toBe("drop");
    expect(
      revealAfterApply({ cursorFile: null, dataUpdatedAt: 1001, pending }),
    ).toBe("wait");
  });
});
