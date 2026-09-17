import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appendArtifacts } from "@/lib/pi/artifacts/artifact-store";
import type { CommitArtifact, DiffArtifact } from "@/lib/artifacts/artifact-types";
import {
  filterSessionCommits,
  sessionCommitShas,
} from "@/lib/pi/review/review-session-commits";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "review-session-commits-test-"));
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

function commitArtifact(
  sha: string,
  projectPath = "semla",
): CommitArtifact {
  return {
    at: "2026-01-01T00:00:00.000Z",
    attribution: "tool-call",
    author: "agent",
    createdAt: "2026-01-01T00:00:00.000Z",
    fileCount: 1,
    files: ["a.ts"],
    kind: "commit",
    key: `call-1:commit:${sha}`,
    projectPath,
    roundId: null,
    sessionId: "session-1",
    sha,
    shortSha: sha.slice(0, 7),
    subject: "fix foo",
    toolCallId: "call-1",
    toolName: "bash",
    turnId: null,
  };
}

function diffArtifact(): DiffArtifact {
  return {
    attribution: "tool-call",
    baseSha: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    files: [],
    filesOmitted: 0,
    headSha: null,
    kind: "diff",
    key: "call-2:diff:0",
    patchFile: null,
    patchTruncated: false,
    projectPath: "semla",
    role: null,
    roundId: null,
    sessionId: "session-1",
    toolCallId: "call-2",
    toolName: "edit",
    turnId: null,
  };
}

describe("sessionCommitShas", () => {
  it("is null when the session has no commit artifacts at all", () => {
    appendArtifacts("session-1", [diffArtifact()], dir);
    expect(sessionCommitShas("session-1", "semla", dir)).toBeNull();
  });

  it("is null for a session with no artifact log", () => {
    expect(sessionCommitShas("missing", "semla", dir)).toBeNull();
  });

  it("collects the shas this session committed in the project", () => {
    appendArtifacts(
      "session-1",
      [commitArtifact("aaa"), commitArtifact("bbb")],
      dir,
    );
    expect(sessionCommitShas("session-1", "semla", dir)).toEqual(
      new Set(["aaa", "bbb"]),
    );
  });

  it("is an empty set — not null — when the commits belong to another project", () => {
    appendArtifacts("session-1", [commitArtifact("aaa", "other")], dir);
    // Empty means "committed nothing here", which must hide every dot;
    // null would mean "no evidence" and show all of them.
    expect(sessionCommitShas("session-1", "semla", dir)).toEqual(new Set());
  });
});

describe("filterSessionCommits", () => {
  const range = [{ sha: "aaa" }, { sha: "bbb" }, { sha: "ccc" }];

  it("drops commits the session is not on record as having made", () => {
    expect(filterSessionCommits(range, new Set(["aaa", "ccc"]))).toEqual([
      { sha: "aaa" },
      { sha: "ccc" },
    ]);
  });

  it("keeps every commit when there is no evidence either way", () => {
    expect(filterSessionCommits(range, null)).toEqual(range);
  });

  it("keeps nothing when the session committed nothing here", () => {
    expect(filterSessionCommits(range, new Set())).toEqual([]);
  });
});
