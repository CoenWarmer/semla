import { describe, expect, it } from "vitest";

import type { ProjectReview } from "@/lib/review-types";

import {
  isReadOnlyPath,
  selectionForWorkspacePath,
} from "./review-definition-target.ts";

const project = (path: string): ProjectReview => ({
  changedFiles: [],
  headSha: null,
  name: path.split("/").pop() ?? path,
  omitted: 0,
  otherActiveSessions: 0,
  path,
  startSha: null,
  turnCommits: [],
});

describe("selectionForWorkspacePath", () => {
  it("splits a path into its project and the path within it", () => {
    expect(
      selectionForWorkspacePath([project("semla")], "semla/src/lib/git.ts"),
    ).toEqual({ path: "src/lib/git.ts", project: "semla" });
  });

  it("picks the right project when a session has several", () => {
    expect(
      selectionForWorkspacePath(
        [project("semla"), project("kibana")],
        "kibana/x-pack/plugin.ts",
      ),
    ).toEqual({ path: "x-pack/plugin.ts", project: "kibana" });
  });

  it("does not accept a sibling whose name starts the same way", () => {
    // `semla` prefixes `semla-wiki`. A string-prefix check would claim this
    // file for the wrong repository and then fail to read it.
    expect(
      selectionForWorkspacePath([project("semla")], "semla-wiki/notes.md"),
    ).toBeNull();
  });

  it("prefers the longest match when one project nests in another", () => {
    // A monorepo and one of its packages both linked: the package is the more
    // specific answer, and the one whose review data covers the file.
    expect(
      selectionForWorkspacePath(
        [project("mono"), project("mono/packages/ui")],
        "mono/packages/ui/src/button.tsx",
      ),
    ).toEqual({ path: "src/button.tsx", project: "mono/packages/ui" });
  });

  it("returns null for a path in none of the projects", () => {
    // Ordinary: a definition can resolve into a dependency installed outside
    // every linked project.
    expect(
      selectionForWorkspacePath([project("semla")], "other/thing.ts"),
    ).toBeNull();
  });

  it("returns null for the project root itself", () => {
    // A directory is not a file to open, and an empty path within a project
    // would address one.
    expect(selectionForWorkspacePath([project("semla")], "semla")).toBeNull();
    expect(selectionForWorkspacePath([project("semla")], "semla/")).toBeNull();
  });
});

describe("isReadOnlyPath", () => {
  it("treats declaration files and dependencies as read-only", () => {
    expect(isReadOnlyPath("semla/node_modules/react/index.d.ts")).toBe(true);
    expect(isReadOnlyPath("semla/src/types/database.types.d.ts")).toBe(true);
    expect(isReadOnlyPath("semla/node_modules/pkg/dist/index.js")).toBe(true);
  });

  it("leaves the repository's own source editable", () => {
    expect(isReadOnlyPath("semla/src/lib/git.ts")).toBe(false);
  });

  it("does not match a directory that merely contains the word", () => {
    // Segment-wise, so a file legitimately named after the directory is not
    // mistaken for one inside it.
    expect(isReadOnlyPath("semla/docs/node_modules-notes.md")).toBe(false);
  });
});
