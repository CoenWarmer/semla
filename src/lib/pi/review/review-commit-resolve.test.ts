/**
 * `resolveSessionCommit` — the narrowing that keeps the hunks route's `sha`
 * parameter answering "did this session commit this" and no wider question.
 *
 * Its own file rather than an addition to review-service's other tests,
 * because the mocks needed here (the artifact store) are not the ones the
 * existing suites in this directory mock.
 *
 * `resolveSessionCommit` used to resolve through the current turn's
 * `start..HEAD` range (`readTurnCommits`), which meant a commit from an
 * earlier turn fell out of range the moment a new turn began —
 * `recordTurnStart` moves the mark's start to HEAD on every prompt. It now
 * resolves straight from the session's own lifetime commit log
 * (`sessionCommitShasOrdered`) via `readCommitsBySha`, which does not move.
 *
 * Two independent checks stand between a query parameter and `git show`, and
 * this is the outer one: `readCommitFileDiff` refuses anything that is not a
 * 40-hex object name (see review-git-integration.test.ts), which stops a
 * revision expression but not a real sha from elsewhere in history. This is
 * what stops that.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TurnCommit } from "@/lib/review/review-types";

const sessionCommitShasOrderedMock = vi.hoisted(() => vi.fn());
const readCommitsByShaMock = vi.hoisted(() => vi.fn());

vi.mock("./review-session-commits", () => ({
  sessionCommitShasOrdered: sessionCommitShasOrderedMock,
}));

vi.mock("./review-status", () => ({
  readChangedFiles: vi.fn(async () => ({ files: [], omitted: 0 })),
  readCommitsBySha: readCommitsByShaMock,
  readHeadSha: vi.fn(async () => null),
  readTurnCommits: vi.fn(async () => []),
}));

const { resolveSessionCommit } = await import("./review-service.ts");

const SHA = "a".repeat(40);
const EARLIER_TURN_SHA = "c".repeat(40);
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
  sessionCommitShasOrderedMock.mockReset();
  readCommitsByShaMock.mockReset();
});

describe("resolveSessionCommit", () => {
  it("resolves a commit this session made", async () => {
    sessionCommitShasOrderedMock.mockReturnValue([SHA]);
    readCommitsByShaMock.mockResolvedValue([commit(SHA)]);

    const found = await resolveSessionCommit("session-1", target, SHA);

    expect(found?.sha).toBe(SHA);
    expect(readCommitsByShaMock).toHaveBeenCalledWith("/tmp/semla", [SHA]);
  });

  it("resolves a commit from an earlier turn, not just the current one", async () => {
    // The regression this file exists to pin: two turns' worth of commits,
    // and a sha from the *first* one — which a turn-scoped range would have
    // dropped the moment the second turn began.
    sessionCommitShasOrderedMock.mockReturnValue([SHA, EARLIER_TURN_SHA]);
    readCommitsByShaMock.mockResolvedValue([commit(EARLIER_TURN_SHA)]);

    const found = await resolveSessionCommit(
      "session-1",
      target,
      EARLIER_TURN_SHA,
    );

    expect(found?.sha).toBe(EARLIER_TURN_SHA);
  });

  it("refuses a real commit this session did not make", async () => {
    // The case the sha validation in readCommitFileDiff cannot catch: a
    // perfectly well-formed object name from elsewhere in history.
    sessionCommitShasOrderedMock.mockReturnValue([SHA]);

    expect(await resolveSessionCommit("session-1", target, ELSEWHERE)).toBeNull();
    expect(readCommitsByShaMock).not.toHaveBeenCalled();
  });

  it("refuses when there is no commit evidence for this project at all", async () => {
    sessionCommitShasOrderedMock.mockReturnValue(null);

    expect(await resolveSessionCommit("session-1", target, SHA)).toBeNull();
    expect(readCommitsByShaMock).not.toHaveBeenCalled();
  });

  it("refuses when the repository no longer has the commit", async () => {
    // readCommitsBySha's --ignore-missing drops a sha that has been rebased
    // away or gc'd rather than failing outright.
    sessionCommitShasOrderedMock.mockReturnValue([SHA]);
    readCommitsByShaMock.mockResolvedValue([]);

    expect(await resolveSessionCommit("session-1", target, SHA)).toBeNull();
  });
});
