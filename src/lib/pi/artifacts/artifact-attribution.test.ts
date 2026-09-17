import { describe, expect, it } from "vitest";

import {
  candidateProjects,
  diffSnapshots,
  isMutatingTool,
  SNAPSHOT_PROJECT_CAP,
} from "@/lib/pi/artifacts/artifact-attribution";
import type { ChangedFile } from "@/lib/review/review-types";

function file(overrides: Partial<ChangedFile> = {}): ChangedFile {
  return {
    indexCode: " ",
    oldPath: null,
    path: "a.ts",
    staged: false,
    status: "modified",
    unstaged: true,
    worktreeCode: "M",
    ...overrides,
  };
}

describe("isMutatingTool", () => {
  it("is true for edit, write and bash", () => {
    expect(isMutatingTool("edit")).toBe(true);
    expect(isMutatingTool("write")).toBe(true);
    expect(isMutatingTool("bash")).toBe(true);
  });

  it("is false for read-only tools", () => {
    expect(isMutatingTool("read")).toBe(false);
    expect(isMutatingTool("grep")).toBe(false);
    expect(isMutatingTool("code_map")).toBe(false);
    expect(isMutatingTool("workflow")).toBe(false);
  });
});

describe("candidateProjects", () => {
  it("returns exactly one candidate for edit/write, the written path", () => {
    expect(
      candidateProjects({
        cwdProject: "other",
        linkedProjects: ["semla"],
        toolName: "edit",
        writtenPath: "semla",
      }),
    ).toEqual(["semla"]);
  });

  it("returns [] for edit/write with no resolved written path", () => {
    expect(
      candidateProjects({
        cwdProject: "semla",
        linkedProjects: [],
        toolName: "write",
        writtenPath: null,
      }),
    ).toEqual([]);
  });

  it("puts the cwd project first for bash, then the linked projects", () => {
    expect(
      candidateProjects({
        cwdProject: "semla",
        linkedProjects: ["other", "semla"],
        toolName: "bash",
        writtenPath: null,
      }),
    ).toEqual(["semla", "other"]);
  });

  it("deduplicates", () => {
    expect(
      candidateProjects({
        cwdProject: "semla",
        linkedProjects: ["semla"],
        toolName: "bash",
        writtenPath: null,
      }),
    ).toEqual(["semla"]);
  });

  it("caps at SNAPSHOT_PROJECT_CAP", () => {
    const linked = Array.from({ length: SNAPSHOT_PROJECT_CAP + 3 }, (_, i) => `p${i}`);
    const result = candidateProjects({
      cwdProject: null,
      linkedProjects: linked,
      toolName: "bash",
      writtenPath: null,
    });
    expect(result).toHaveLength(SNAPSHOT_PROJECT_CAP);
  });

  it("returns [] for bash with no cwd project and no linked projects", () => {
    expect(
      candidateProjects({
        cwdProject: null,
        linkedProjects: [],
        toolName: "bash",
        writtenPath: null,
      }),
    ).toEqual([]);
  });
});

describe("diffSnapshots", () => {
  it("reports unchanged when nothing moved", () => {
    const files = [file()];
    const result = diffSnapshots({ files, head: "h1" }, { files, head: "h1" });
    expect(result).toEqual({ changed: false, committed: false, paths: [] });
  });

  it("detects an added path", () => {
    const result = diffSnapshots(
      { files: [], head: "h1" },
      { files: [file({ path: "new.ts" })], head: "h1" },
    );
    expect(result.changed).toBe(true);
    expect(result.committed).toBe(false);
    expect(result.paths).toEqual([{ oldPath: null, path: "new.ts", status: "modified" }]);
  });

  it("detects a removed path", () => {
    const result = diffSnapshots(
      { files: [file({ path: "gone.ts" })], head: "h1" },
      { files: [], head: "h1" },
    );
    expect(result.paths).toEqual([]);
  });

  it("detects a status change on the same path", () => {
    const result = diffSnapshots(
      { files: [file({ indexCode: " ", worktreeCode: "M" })], head: "h1" },
      { files: [file({ indexCode: "A", worktreeCode: " ", status: "added" })], head: "h1" },
    );
    expect(result.paths).toEqual([{ oldPath: null, path: "a.ts", status: "added" }]);
  });

  it("reports committed only when head moved", () => {
    const files = [file()];
    const result = diffSnapshots({ files, head: "h1" }, { files, head: "h2" });
    expect(result.committed).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.paths).toEqual([]);
  });

  it("does not report a path dirty in both snapshots with the same codes", () => {
    const dirty = file({ indexCode: " ", worktreeCode: "M" });
    const result = diffSnapshots({ files: [dirty], head: "h1" }, { files: [dirty], head: "h1" });
    expect(result.paths).toEqual([]);
    expect(result.changed).toBe(false);
  });
});
