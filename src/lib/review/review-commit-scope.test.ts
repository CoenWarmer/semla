/**
 * The rows the changed-files list shows, per commit-nav selection.
 *
 * Worth its own file because the rule this pins is one the panel had wrong for
 * as long as the commit dots existed, and the bug was invisible: intersecting
 * a commit's paths with `git status` showed nothing for a commit whose files
 * were all clean, which is the normal state of a committed file. The first
 * test below is that case.
 */

import { describe, expect, it } from "vitest";

import { changedFileFromCommit, commitScope } from "./review-commit-scope.ts";
import type {
  ChangedFile,
  ProjectReview,
  TurnCommit,
} from "./review-types.ts";

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

function changed(overrides: Partial<ChangedFile> = {}): ChangedFile {
  return {
    indexCode: " ",
    oldPath: null,
    path: "dirty.ts",
    staged: false,
    status: "modified",
    unstaged: true,
    worktreeCode: "M",
    ...overrides,
  };
}

function commit(overrides: Partial<TurnCommit> = {}): TurnCommit {
  const fileChanges = overrides.fileChanges ?? [
    { oldPath: null, path: "committed.ts", status: "modified" as const },
  ];
  return {
    at: "2026-09-03T10:00:00Z",
    author: "agent",
    fileCount: fileChanges.length,
    files: fileChanges.map((change) => change.path),
    sha: SHA,
    shortSha: "aaaaaaa",
    subject: "[Agent]: done",
    ...overrides,
    fileChanges,
  };
}

function project(overrides: Partial<ProjectReview> = {}): ProjectReview {
  return {
    changedFiles: [changed()],
    headSha: SHA,
    name: "semla",
    omitted: 0,
    otherActiveSessions: 0,
    path: "semla",
    startSha: OTHER_SHA,
    turnCommits: [commit()],
    ...overrides,
  };
}

describe("commitScope", () => {
  it("shows a commit's files even when every one of them is clean now", () => {
    // The whole point. `changedFiles` does not mention committed.ts, because
    // git status does not report a file that matches HEAD.
    const scope = commitScope(project(), SHA);

    expect(scope.commit?.sha).toBe(SHA);
    expect(scope.files.map((file) => file.path)).toEqual(["committed.ts"]);
  });

  it("shows the working tree when nothing is selected", () => {
    const scope = commitScope(project(), null);

    expect(scope.commit).toBeNull();
    expect(scope.files.map((file) => file.path)).toEqual(["dirty.ts"]);
  });

  it("shows no uncommitted file alongside a selected commit", () => {
    const scope = commitScope(
      project({
        changedFiles: [changed(), changed({ path: "committed.ts" })],
      }),
      SHA,
    );

    // committed.ts is dirty *as well*, and still appears exactly once — as the
    // commit's row, not the worktree's.
    expect(scope.files).toHaveLength(1);
    expect(scope.files[0]).toMatchObject({ path: "committed.ts", unstaged: false });
  });

  it("carries a rename's original path through to the row", () => {
    const scope = commitScope(
      project({
        turnCommits: [
          commit({
            fileChanges: [
              { oldPath: "src/old.ts", path: "src/new.ts", status: "renamed" },
            ],
          }),
        ],
      }),
      SHA,
    );

    expect(scope.files[0]).toMatchObject({
      oldPath: "src/old.ts",
      path: "src/new.ts",
      status: "renamed",
    });
  });

  it("falls back to the working tree for a sha this project has no commit for", () => {
    // A stale selection — an artifact chip naming an earlier turn's commit, or
    // a refetch after the turn mark was cleared. Recoverable; an empty list
    // would read as a project with no changes at all.
    const scope = commitScope(project(), OTHER_SHA);

    expect(scope.commit).toBeNull();
    expect(scope.files.map((file) => file.path)).toEqual(["dirty.ts"]);
  });

  it("has nothing to show without a project", () => {
    expect(commitScope(null, SHA)).toEqual({ commit: null, files: [] });
    expect(commitScope(undefined, null)).toEqual({ commit: null, files: [] });
  });
});

describe("changedFileFromCommit", () => {
  it("marks a commit's file as neither staged nor unstaged", () => {
    // This is what makes the rows read-only: every staging affordance in the
    // list keys off these flags, so a commit's row offers none.
    expect(
      changedFileFromCommit({ oldPath: null, path: "a.ts", status: "added" }),
    ).toEqual({
      indexCode: " ",
      oldPath: null,
      path: "a.ts",
      staged: false,
      status: "added",
      unstaged: false,
      worktreeCode: " ",
    });
  });
});
