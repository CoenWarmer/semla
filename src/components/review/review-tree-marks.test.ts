import { describe, expect, it } from "vitest";

import type { ChangedFile, ProjectReview } from "@/lib/review-types";

import {
  directoriesToExpand,
  indexChanges,
  MAX_AUTO_EXPANDED,
  workspacePathOf,
} from "./review-tree-marks.ts";

const file = (path: string, overrides: Partial<ChangedFile> = {}): ChangedFile => ({
  indexCode: " ",
  oldPath: null,
  path,
  staged: false,
  status: "modified",
  unstaged: true,
  worktreeCode: "M",
  ...overrides,
});

const project = (
  path: string,
  changedFiles: ChangedFile[],
): ProjectReview => ({
  changedFiles,
  headSha: "abc",
  name: path.split("/").pop() ?? path,
  omitted: 0,
  path,
  startSha: "abc",
  turnCommits: [],
});

describe("workspacePathOf", () => {
  it("joins the project link and the project-relative path", () => {
    // The tree speaks workspace-relative paths; the review speaks
    // project-relative ones.
    expect(workspacePathOf("semla", "src/a.ts")).toBe("semla/src/a.ts");
  });
});

describe("indexChanges", () => {
  it("marks each changed file by its workspace-relative path", () => {
    const index = indexChanges([
      project("semla", [file("src/lib/a.ts"), file("README.md", { status: "added" })]),
    ]);

    expect(index.files.get("semla/src/lib/a.ts")).toBe("modified");
    expect(index.files.get("semla/README.md")).toBe("added");
  });

  it("counts changes against every directory above them", () => {
    // What lets a collapsed folder say "there is something in here".
    const index = indexChanges([
      project("semla", [file("src/lib/a.ts"), file("src/lib/b.ts")]),
    ]);

    expect(index.directories.get("semla/src/lib")).toBe(2);
    expect(index.directories.get("semla/src")).toBe(2);
    expect(index.directories.get("semla")).toBe(2);
  });

  it("does not count a file against a sibling directory", () => {
    const index = indexChanges([
      project("semla", [file("src/lib/a.ts"), file("docs/plan.md")]),
    ]);

    expect(index.directories.get("semla/src")).toBe(1);
    expect(index.directories.get("semla/docs")).toBe(1);
    expect(index.directories.has("semla/scripts")).toBe(false);
  });

  it("keeps two projects apart", () => {
    const index = indexChanges([
      project("semla", [file("src/a.ts")]),
      project("kibana", [file("src/a.ts")]),
    ]);

    expect(index.files.has("semla/src/a.ts")).toBe(true);
    expect(index.files.has("kibana/src/a.ts")).toBe(true);
    expect(index.directories.get("semla/src")).toBe(1);
    expect(index.directories.get("kibana/src")).toBe(1);
  });

  it("counts a rename at its destination only", () => {
    // The source is gone, so there is no tree row to mark and counting it
    // would leave a directory claiming to hold something it does not.
    const index = indexChanges([
      project("semla", [
        file("src/new.ts", { oldPath: "old/gone.ts", status: "renamed" }),
      ]),
    ]);

    expect(index.files.has("semla/src/new.ts")).toBe(true);
    expect(index.directories.has("semla/old")).toBe(false);
  });

  it("indexes nothing from a project with no changes", () => {
    const index = indexChanges([project("semla", [])]);
    expect(index.files.size).toBe(0);
    expect(index.directories.size).toBe(0);
  });
});

describe("directoriesToExpand", () => {
  it("opens the path down to each changed file", () => {
    const index = indexChanges([project("semla", [file("src/lib/pi/git.ts")])]);

    expect(directoriesToExpand(index, "semla")).toEqual(
      new Set(["semla", "semla/src", "semla/src/lib", "semla/src/lib/pi"]),
    );
  });

  it("always opens the project root, even with nothing changed", () => {
    const index = indexChanges([project("semla", [])]);
    expect(directoriesToExpand(index, "semla")).toEqual(new Set(["semla"]));
  });

  it("leaves another project's directories alone", () => {
    // Expanding paths in a repository that is not on screen is state nobody
    // can see or collapse.
    const index = indexChanges([
      project("semla", [file("src/a.ts")]),
      project("kibana", [file("x-pack/b.ts")]),
    ]);

    expect(directoriesToExpand(index, "semla")).toEqual(
      new Set(["semla", "semla/src"]),
    );
  });

  it("opens the root only when a turn touched too many directories", () => {
    // A wall of expanded folders has no shape to read, which is the opposite
    // of what the tree is for. The bucket still lists every file.
    const many = Array.from({ length: MAX_AUTO_EXPANDED + 1 }, (_, i) =>
      file(`pkg${i}/index.ts`),
    );
    const index = indexChanges([project("semla", many)]);

    expect(directoriesToExpand(index, "semla")).toEqual(new Set(["semla"]));
  });
});
