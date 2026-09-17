/**
 * `resolveSessionCommit` — the narrowing that keeps the hunks route's `sha`
 * parameter answering "what did this turn's commit do" and no wider question.
 *
 * Its own file rather than an addition to review-service's other tests,
 * because the mocks needed here (the turn mark, the project links) are the
 * ones review-service reads at module scope and the existing suites in this
 * directory mock `../git/git` instead.
 *
 * Two independent checks stand between a query parameter and `git show`, and
 * this is the outer one: `readCommitFileDiff` refuses anything that is not a
 * 40-hex object name (see review-git-integration.test.ts), which stops a
 * revision expression but not a real sha from elsewhere in history. This is
 * what stops that.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TurnCommit } from "@/lib/review/review-types";

const readTurnMarkMock = vi.hoisted(() => vi.fn());
const readTurnCommitsMock = vi.hoisted(() => vi.fn());

vi.mock("./review-turn-mark", () => ({
  fingerprint: vi.fn(() => "fp"),
  readTurnMark: readTurnMarkMock,
  writeTurnMark: vi.fn(),
}));

vi.mock("./review-status", () => ({
  readChangedFiles: vi.fn(async () => ({ files: [], omitted: 0 })),
  readHeadSha: vi.fn(async () => null),
  readTurnCommits: readTurnCommitsMock,
}));

const { resolveSessionCommit } = await import("./review-service.ts");

const SHA = "a".repeat(40);
const ELSEWHERE = "b".repeat(40);

const target = {
  link: { path: "semla" } as never,
  root: "/tmp/semla",
};

const commit = (sha: string): TurnCommit => ({
  at: "2026-09-03T10:00:00Z",
  author: "agent",
  fileChanges: [{ oldPath: null, path: "a.ts", status: "modified" }],
  fileCount: 1,
  files: ["a.ts"],
  sha,
  shortSha: sha.slice(0, 7),
  subject: "[Agent]: done",
});

beforeEach(() => {
  readTurnMarkMock.mockReset();
  readTurnCommitsMock.mockReset();
});

describe("resolveSessionCommit", () => {
  it("resolves a commit from this session's own turn range", async () => {
    readTurnMarkMock.mockReturnValue({ projects: { semla: { head: "start" } } });
    readTurnCommitsMock.mockResolvedValue([commit(SHA)]);

    const found = await resolveSessionCommit("session-1", target, SHA);

    expect(found?.sha).toBe(SHA);
    // The range is the mark's head, not anything the caller supplied.
    expect(readTurnCommitsMock).toHaveBeenCalledWith("/tmp/semla", "start");
  });

  it("refuses a real commit that is not in the turn range", async () => {
    // The case the sha validation in readCommitFileDiff cannot catch: a
    // perfectly well-formed object name from elsewhere in history.
    readTurnMarkMock.mockReturnValue({ projects: { semla: { head: "start" } } });
    readTurnCommitsMock.mockResolvedValue([commit(SHA)]);

    expect(await resolveSessionCommit("session-1", target, ELSEWHERE)).toBeNull();
  });

  it("refuses when there is no turn mark, rather than reading all of history", async () => {
    readTurnMarkMock.mockReturnValue(null);

    expect(await resolveSessionCommit("session-1", target, SHA)).toBeNull();
    expect(readTurnCommitsMock).not.toHaveBeenCalled();
  });

  it("refuses when the mark has no head for this project", async () => {
    // A session linked to two repositories, only one of which was marked.
    readTurnMarkMock.mockReturnValue({ projects: { other: { head: "start" } } });

    expect(await resolveSessionCommit("session-1", target, SHA)).toBeNull();
    expect(readTurnCommitsMock).not.toHaveBeenCalled();
  });

  it("refuses when the range itself is refused", async () => {
    // readTurnCommits answers [] for a start sha that is no longer an ancestor
    // of HEAD — a rebase since the turn began. Nothing is resolvable then.
    readTurnMarkMock.mockReturnValue({ projects: { semla: { head: "start" } } });
    readTurnCommitsMock.mockResolvedValue([]);

    expect(await resolveSessionCommit("session-1", target, SHA)).toBeNull();
  });
});
