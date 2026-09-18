import { describe, expect, it } from "vitest";

import { dirtyFilesFromReview } from "@/lib/artifacts/artifact-dirty";
import type { ChangedFile, ProjectReview, SessionReview } from "@/lib/review/review-types";

const changed = (over: Partial<ChangedFile> & Pick<ChangedFile, "path">): ChangedFile => ({
  indexCode: " ",
  oldPath: null,
  staged: false,
  status: "modified",
  unstaged: true,
  worktreeCode: "M",
  ...over,
});

const project = (
  over: Partial<ProjectReview> & Pick<ProjectReview, "path">,
): ProjectReview => ({
  changedFiles: [],
  headSha: "abc",
  name: over.path.split("/").pop() ?? over.path,
  omitted: 0,
  otherActiveSessions: 0,
  startSha: "abc",
  turnCommits: [],
  ...over,
});

const review = (projects: ProjectReview[]): SessionReview => ({
  changedThisTurn: false,
  fingerprint: "f",
  projects,
  reviewed: false,
});

describe("dirtyFilesFromReview", () => {
  it("keys uncommitted paths by workspace-relative project path", () => {
    const dirty = dirtyFilesFromReview(
      review([
        project({ changedFiles: [changed({ path: "src/a.ts" })], path: "semla" }),
        project({ changedFiles: [changed({ path: "lib/b.ts" })], path: "ecs" }),
      ]),
    );

    expect([...(dirty?.get("semla") ?? [])]).toEqual(["src/a.ts"]);
    expect([...(dirty?.get("ecs") ?? [])]).toEqual(["lib/b.ts"]);
  });

  it("includes both names of a rename", () => {
    // An artifact captured before the rename recorded the old path; git
    // reports the new one. Both describe the same uncommitted change, so a
    // diff chip on either must survive the filter.
    const dirty = dirtyFilesFromReview(
      review([
        project({
          changedFiles: [changed({ oldPath: "src/old.ts", path: "src/new.ts", status: "renamed" })],
          path: "semla",
        }),
      ]),
    );

    expect(dirty?.get("semla")?.has("src/old.ts")).toBe(true);
    expect(dirty?.get("semla")?.has("src/new.ts")).toBe(true);
  });

  it("reports a clean project as an EMPTY set, not as absent", () => {
    // The distinction the filter turns on: an empty set means "git says
    // nothing is dirty here", while a missing project means "no answer".
    const dirty = dirtyFilesFromReview(review([project({ path: "semla" })]));
    expect(dirty?.has("semla")).toBe(true);
    expect(dirty?.get("semla")?.size).toBe(0);
  });

  it("is undefined when there is no review yet", () => {
    expect(dirtyFilesFromReview(null)).toBeUndefined();
    expect(dirtyFilesFromReview(undefined)).toBeUndefined();
  });
});
