import { describe, expect, it, vi } from "vitest";

import { captureArtifacts, type CaptureDeps, type CaptureInput } from "@/lib/pi/artifacts/artifact-capture";
import { clearSession, seedSnapshots } from "@/lib/pi/artifacts/artifact-snapshot-cache";
import type { ProjectSnapshot } from "@/lib/pi/artifacts/artifact-snapshot";
import type { ChangedFile, FileDiff, TurnCommit } from "@/lib/review/review-types";
import type { DiffArtifact } from "@/lib/artifacts/artifact-types";

let sessionCounter = 0;
function freshSession(): string {
  sessionCounter += 1;
  return `session-${sessionCounter}`;
}

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

function snapshot(overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    at: "2026-01-01T00:00:00.000Z",
    files: [],
    head: "h1",
    projectPath: "semla",
    root: "/workspace/semla",
    state: "state-1",
    ...overrides,
  };
}

function baseInput(sessionId: string, overrides: Partial<CaptureInput> = {}): CaptureInput {
  return {
    attribution: "tool-call",
    command: null,
    output: null,
    projects: [{ projectPath: "semla", root: "/workspace/semla" }],
    roundId: "live-round-0",
    sessionId,
    toolCallId: "call-1",
    toolName: "bash",
    turnId: "20260101T000000000Z-aaaaaaaa",
    ...overrides,
  };
}

function fileDiff(overrides: Partial<FileDiff> = {}): FileDiff {
  return {
    binary: false,
    header: "diff --git a/a.ts b/a.ts",
    hunks: [
      {
        heading: "fn",
        index: 0,
        lines: [{ kind: "added", newLine: 1, noNewline: false, oldLine: null, spans: [], text: "x" }],
        newLines: 1,
        newStart: 1,
        oldLines: 0,
        oldStart: 0,
      },
    ],
    modeChangeOnly: false,
    oldPath: null,
    path: "a.ts",
    ...overrides,
  };
}

function commit(overrides: Partial<TurnCommit> = {}): TurnCommit {
  return {
    at: "2026-01-01T00:00:00.000Z",
    author: "agent",
    fileChanges: [{ oldPath: null, path: "a.ts", status: "modified" as const }],
    fileCount: 1,
    files: ["a.ts"],
    sha: "sha1",
    shortSha: "sha1sh",
    subject: "fix foo",
    ...overrides,
  };
}

describe("captureArtifacts", () => {
  it("returns [] on a cache miss, and caches the snapshot for next time", async () => {
    const sessionId = freshSession();
    const readSnapshot = vi.fn().mockResolvedValue(snapshot());
    const readDiff = vi.fn();
    const readCommits = vi.fn();

    const result = await captureArtifacts(baseInput(sessionId), {
      readCommits,
      readDiff,
      readSnapshot,
    });

    expect(result.artifacts).toEqual([]);
    expect(readDiff).not.toHaveBeenCalled();
    expect(readCommits).not.toHaveBeenCalled();
    clearSession(sessionId);
  });

  it("costs zero diff/commit reads when the state is unchanged", async () => {
    const sessionId = freshSession();
    seedSnapshots(sessionId, [snapshot()]);

    const readDiff = vi.fn();
    const readCommits = vi.fn();
    const readSnapshot = vi.fn().mockResolvedValue(snapshot());

    const result = await captureArtifacts(baseInput(sessionId), {
      readCommits,
      readDiff,
      readSnapshot,
    });

    expect(result.artifacts).toEqual([]);
    expect(readDiff).not.toHaveBeenCalled();
    expect(readCommits).not.toHaveBeenCalled();
    clearSession(sessionId);
  });

  it("produces a diff artifact with hunk anchors for a changed file", async () => {
    const sessionId = freshSession();
    seedSnapshots(sessionId, [snapshot()]);

    const after = snapshot({ files: [file({ path: "b.ts", worktreeCode: "M" })], state: "state-2" });
    const readSnapshot = vi.fn().mockResolvedValue(after);
    const readDiff = vi.fn().mockResolvedValue(fileDiff({ path: "b.ts" }));
    const readCommits = vi.fn();

    const result = await captureArtifacts(baseInput(sessionId), {
      readCommits,
      readDiff,
      readSnapshot,
    });

    expect(result.artifacts).toHaveLength(1);
    const diff = result.artifacts[0] as DiffArtifact;
    expect(diff.kind).toBe("diff");
    expect(diff.files[0].path).toBe("b.ts");
    expect(diff.files[0].hunks).toHaveLength(1);
    expect(diff.files[0].hunksOmitted).toBe(false);
    expect(diff.turnId).toBe("20260101T000000000Z-aaaaaaaa");
    expect(readCommits).not.toHaveBeenCalled();
    clearSession(sessionId);
  });

  it("stamps turnId null when no turn was supplied", async () => {
    const sessionId = freshSession();
    seedSnapshots(sessionId, [snapshot()]);

    const after = snapshot({ files: [file({ path: "b.ts", worktreeCode: "M" })], state: "state-2" });
    const readSnapshot = vi.fn().mockResolvedValue(after);
    const readDiff = vi.fn().mockResolvedValue(fileDiff({ path: "b.ts" }));
    const readCommits = vi.fn();

    const result = await captureArtifacts(baseInput(sessionId, { turnId: null }), {
      readCommits,
      readDiff,
      readSnapshot,
    });

    const diff = result.artifacts[0] as DiffArtifact;
    expect(diff.turnId).toBeNull();
    clearSession(sessionId);
  });

  it("marks hunksOmitted beyond ARTIFACT_HUNK_FILES without reading their diff", async () => {
    const sessionId = freshSession();
    seedSnapshots(sessionId, [snapshot()]);

    const files = Array.from({ length: 12 }, (_, i) => file({ path: `f${i}.ts` }));
    const after = snapshot({ files, state: "state-2" });
    const readSnapshot = vi.fn().mockResolvedValue(after);
    const readDiff = vi.fn().mockResolvedValue(fileDiff());
    const readCommits = vi.fn();

    const result = await captureArtifacts(baseInput(sessionId), {
      readCommits,
      readDiff,
      readSnapshot,
    });

    const diff = result.artifacts[0] as DiffArtifact;
    expect(diff.files).toHaveLength(12);
    expect(diff.files.slice(0, 10).every((f) => !f.hunksOmitted)).toBe(true);
    expect(diff.files.slice(10).every((f) => f.hunksOmitted)).toBe(true);
    expect(readDiff).toHaveBeenCalledTimes(10);
    clearSession(sessionId);
  });

  it("produces commit artifacts when head moved", async () => {
    const sessionId = freshSession();
    seedSnapshots(sessionId, [snapshot()]);

    const after = snapshot({ head: "h2", state: "state-2" });
    const readSnapshot = vi.fn().mockResolvedValue(after);
    const readDiff = vi.fn();
    const readCommits = vi.fn().mockResolvedValue([commit()]);

    const result = await captureArtifacts(baseInput(sessionId), {
      readCommits,
      readDiff,
      readSnapshot,
    });

    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].kind).toBe("commit");
    expect(result.artifacts[0].turnId).toBe("20260101T000000000Z-aaaaaaaa");
    expect(readCommits).toHaveBeenCalledWith("/workspace/semla", "h1");
    clearSession(sessionId);
  });

  it("produces both a commit and a diff artifact when both happened", async () => {
    const sessionId = freshSession();
    seedSnapshots(sessionId, [snapshot()]);

    const after = snapshot({
      files: [file({ path: "b.ts" })],
      head: "h2",
      state: "state-2",
    });
    const readSnapshot = vi.fn().mockResolvedValue(after);
    const readDiff = vi.fn().mockResolvedValue(fileDiff({ path: "b.ts" }));
    const readCommits = vi.fn().mockResolvedValue([commit()]);

    const result = await captureArtifacts(baseInput(sessionId), {
      readCommits,
      readDiff,
      readSnapshot,
    });

    const kinds = result.artifacts.map((a) => a.kind).sort();
    expect(kinds).toEqual(["commit", "diff"]);
    clearSession(sessionId);
  });

  it("attributes a detected PR once, not once per candidate project", async () => {
    const sessionId = freshSession();
    seedSnapshots(sessionId, [
      snapshot({ projectPath: "semla", root: "/workspace/semla" }),
      snapshot({ projectPath: "other", root: "/workspace/other" }),
    ]);

    const readSnapshot: CaptureDeps["readSnapshot"] = vi.fn(async (projectPath, root) =>
      snapshot({ projectPath, root }),
    );
    const readDiff = vi.fn();
    const readCommits = vi.fn();

    const result = await captureArtifacts(
      baseInput(sessionId, {
        command: "gh pr create --title x",
        output: "https://github.com/o/r/pull/1",
        projects: [
          { projectPath: "semla", root: "/workspace/semla" },
          { projectPath: "other", root: "/workspace/other" },
        ],
      }),
      { readCommits, readDiff, readSnapshot },
    );

    const prs = result.artifacts.filter((a) => a.kind === "pr");
    expect(prs).toHaveLength(1);
    expect(prs[0].turnId).toBe("20260101T000000000Z-aaaaaaaa");
    clearSession(sessionId);
  });
  it("stamps every artifact from one call with the minted turnId", async () => {
    // The regression guard for the join itself. turnId is threaded from the
    // prompt route through captureAndRecord to here, and a break anywhere on
    // that path shows up as a null id on disk — which once looked exactly
    // like a bug and was in fact a stale dev server. This pins the contract
    // so the two can never again be confused.
    const sessionId = freshSession();
    seedSnapshots(sessionId, [snapshot()]);

    const readSnapshot = vi
      .fn()
      .mockResolvedValue(snapshot({ files: [file()], head: "h2", state: "state-2" }));
    const readDiff = vi.fn().mockResolvedValue(fileDiff());
    const readCommits = vi.fn().mockResolvedValue([commit()]);

    const result = await captureArtifacts(
      baseInput(sessionId, { turnId: "20260917T083301007Z-0dfc1e61" }),
      { readCommits, readDiff, readSnapshot },
    );

    expect(result.artifacts.length).toBeGreaterThan(0);
    for (const artifact of result.artifacts) {
      expect(artifact.turnId).toBe("20260917T083301007Z-0dfc1e61");
    }
    clearSession(sessionId);
  });

  it("records a null turnId rather than inventing one outside a prompt turn", async () => {
    // A background continuation genuinely has no turn in flight. Null is the
    // honest answer; a synthesised id would make an unjoinable artifact look
    // joinable. See ArtifactCore.turnId.
    const sessionId = freshSession();
    seedSnapshots(sessionId, [snapshot()]);

    const readSnapshot = vi
      .fn()
      .mockResolvedValue(snapshot({ files: [file()], head: "h2", state: "state-2" }));
    const readDiff = vi.fn().mockResolvedValue(fileDiff());
    const readCommits = vi.fn().mockResolvedValue([]);

    const result = await captureArtifacts(baseInput(sessionId, { turnId: null }), {
      readCommits,
      readDiff,
      readSnapshot,
    });

    const diffs = result.artifacts.filter((a) => a.kind === "diff");
    expect(diffs).toHaveLength(1);
    expect(diffs[0].turnId).toBeNull();
    clearSession(sessionId);
  });

  it("carries a declared role onto the diff, beating the path", async () => {
    const sessionId = freshSession();
    seedSnapshots(sessionId, [snapshot()]);

    const readSnapshot = vi
      .fn()
      .mockResolvedValue(snapshot({ files: [file()], head: "h2", state: "state-2" }));
    const readDiff = vi.fn().mockResolvedValue(fileDiff());
    const readCommits = vi.fn().mockResolvedValue([]);

    const result = await captureArtifacts(
      baseInput(sessionId, { declaredRole: "plan", writtenPath: "src/lib/thing.ts" }),
      { readCommits, readDiff, readSnapshot },
    );

    const diffs = result.artifacts.filter((a): a is DiffArtifact => a.kind === "diff");
    expect(diffs[0].role).toEqual({ name: "plan", source: "declared" });
    clearSession(sessionId);
  });

  it("infers a plan role from the written path when none was declared", async () => {
    const sessionId = freshSession();
    seedSnapshots(sessionId, [snapshot()]);

    const readSnapshot = vi
      .fn()
      .mockResolvedValue(snapshot({ files: [file()], head: "h2", state: "state-2" }));
    const readDiff = vi.fn().mockResolvedValue(fileDiff());
    const readCommits = vi.fn().mockResolvedValue([]);

    const result = await captureArtifacts(
      baseInput(sessionId, { writtenPath: "docs/plans/commit-scoped-review.md" }),
      { readCommits, readDiff, readSnapshot },
    );

    const diffs = result.artifacts.filter((a): a is DiffArtifact => a.kind === "diff");
    expect(diffs[0].role).toEqual({ name: "plan", source: "inferred" });
    clearSession(sessionId);
  });

  it("leaves an ordinary source diff with no role at all", async () => {
    const sessionId = freshSession();
    seedSnapshots(sessionId, [snapshot()]);

    const readSnapshot = vi
      .fn()
      .mockResolvedValue(snapshot({ files: [file()], head: "h2", state: "state-2" }));
    const readDiff = vi.fn().mockResolvedValue(fileDiff());
    const readCommits = vi.fn().mockResolvedValue([]);

    const result = await captureArtifacts(
      baseInput(sessionId, { writtenPath: "src/lib/artifacts/diff-role.ts" }),
      { readCommits, readDiff, readSnapshot },
    );

    const diffs = result.artifacts.filter((a): a is DiffArtifact => a.kind === "diff");
    expect(diffs[0].role).toBeNull();
    clearSession(sessionId);
  });
});
