import { describe, expect, it } from "vitest";

import { shouldOpenReview } from "./review-open.ts";
import type { ProjectReview, SessionReview } from "./review-types.ts";

const project = (overrides: Partial<ProjectReview> = {}): ProjectReview => ({
  changedFiles: [],
  headSha: "abc",
  name: "semla",
  omitted: 0,
  path: "semla",
  startSha: "abc",
  turnCommits: [],
  ...overrides,
});

const changedFile = { path: "src/a.ts" } as ProjectReview["changedFiles"][number];

const review = (overrides: Partial<SessionReview> = {}): SessionReview => ({
  changedThisTurn: true,
  fingerprint: "f1",
  projects: [project({ changedFiles: [changedFile] })],
  reviewed: false,
  ...overrides,
});

describe("shouldOpenReview", () => {
  it("opens after a turn that changed something", () => {
    expect(
      shouldOpenReview({
        manuallyOpened: false,
        review: review(),
        sessionRunning: false,
      }),
    ).toBe(true);
  });

  it("stays shut while a turn is running", () => {
    // The agent is still writing; a panel over that is describing a moving tree.
    expect(
      shouldOpenReview({
        manuallyOpened: false,
        review: review(),
        sessionRunning: true,
      }),
    ).toBe(false);
  });

  it("stays shut for a tree that was already dirty before the turn", () => {
    // Dirty is not the same as changed-this-turn. Opening on yesterday's
    // uncommitted work is how a panel teaches people to dismiss it unread.
    expect(
      shouldOpenReview({
        manuallyOpened: false,
        review: review({ changedThisTurn: false }),
        sessionRunning: false,
      }),
    ).toBe(false);
  });

  it("stays shut once the operator has dismissed this state", () => {
    expect(
      shouldOpenReview({
        manuallyOpened: false,
        review: review({ reviewed: true }),
        sessionRunning: false,
      }),
    ).toBe(false);
  });

  it("stays shut when there is nothing to show", () => {
    expect(
      shouldOpenReview({
        manuallyOpened: false,
        review: review({ projects: [project()] }),
        sessionRunning: false,
      }),
    ).toBe(false);
  });

  it("opens for commits alone, with no uncommitted change", () => {
    // The agent committed its work. There are no changed files, and this is
    // exactly the case that is invisible without the panel.
    const committed = review({
      projects: [
        project({
          turnCommits: [
            {
              at: "2026-09-03T10:00:00Z",
              author: "Test",
              fileCount: 2,
              sha: "a".repeat(40),
              shortSha: "aaaaaaa",
              subject: "[Agent]: done",
            },
          ],
        }),
      ],
    });

    expect(
      shouldOpenReview({
        manuallyOpened: false,
        review: committed,
        sessionRunning: false,
      }),
    ).toBe(true);
  });

  it("stays shut before the first read resolves", () => {
    expect(
      shouldOpenReview({
        manuallyOpened: false,
        review: undefined,
        sessionRunning: false,
      }),
    ).toBe(false);
  });

  it("opens when asked, whatever the rules say", () => {
    // A dismissal must never be a dead end, and neither must a running turn.
    expect(
      shouldOpenReview({
        manuallyOpened: true,
        review: review({ changedThisTurn: false, reviewed: true }),
        sessionRunning: true,
      }),
    ).toBe(true);
    expect(
      shouldOpenReview({
        manuallyOpened: true,
        review: undefined,
        sessionRunning: false,
      }),
    ).toBe(true);
  });
});
