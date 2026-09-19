import { describe, expect, it } from "vitest";

import type { ChangedFile } from "@/lib/review/review-types";

import { fileRowLayoutId } from "./review-changed-files.tsx";

const fileOf = (staged: boolean, unstaged: boolean): ChangedFile => ({
  indexCode: staged ? "M" : " ",
  oldPath: null,
  path: "src/f.ts",
  staged,
  status: "modified",
  unstaged,
  worktreeCode: unstaged ? "M" : " ",
});

describe("fileRowLayoutId", () => {
  it("gives a fully staged file a shared id, so its row can animate into the bucket", () => {
    const id = fileRowLayoutId(
      { path: "src/f.ts", project: "app" },
      fileOf(true, false),
    );
    expect(id).toBe("app/src/f.ts");
  });

  it("gives a fully unstaged file the same shared id as the staged case", () => {
    const id = fileRowLayoutId(
      { path: "src/f.ts", project: "app" },
      fileOf(false, true),
    );
    expect(id).toBe("app/src/f.ts");
  });

  it("withholds the id for a partially staged file, which is drawn in both buckets at once", () => {
    // The bug this guards: FileRow (drawn because `unstaged`) and
    // StagedFileRow (drawn because `staged`) are both mounted simultaneously
    // for this file. Motion's `layoutId` assumes at most one mounted
    // instance per id; two at once makes it pick a "lead" and force the
    // other's layout to track it, which emptied the Staged bucket's hunk
    // list until every hunk was staged and FileRow finally unmounted.
    const id = fileRowLayoutId(
      { path: "src/f.ts", project: "app" },
      fileOf(true, true),
    );
    expect(id).toBeUndefined();
  });
});
