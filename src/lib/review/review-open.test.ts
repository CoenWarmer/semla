import { describe, expect, it } from "vitest";

import {
  openingWrite,
  shouldFollowOpen,
  shouldOpenReview,
} from "./review-open.ts";
import type { FileAccess } from "../pi/file-access/access-types.ts";
import type { ProjectReview, SessionReview } from "./review-types.ts";

const project = (overrides: Partial<ProjectReview> = {}): ProjectReview => ({
  changedFiles: [],
  headSha: "abc",
  name: "semla",
  omitted: 0,
  otherActiveSessions: 0,
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
              files: ["src/a.ts", "src/b.ts"],
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

/**
 * The contract client-session-component's `handleSubmit` relies on when it
 * promotes `manuallyOpened` for an already-open panel (search: reviewOpen).
 *
 * These pin the *precondition* for that fix, not the fix: `manuallyOpened` is
 * the only signal that survives `sessionRunning`, which is why the component
 * has to set it before a turn starts. They would still pass if the promotion
 * were removed — the promotion itself is in a component, and this repository
 * has no DOM test environment to render one. Verified by hand instead; see the
 * commit message.
 */
describe("shouldOpenReview across the start of a new turn", () => {
  it("keeps a manually opened panel open once a turn starts", () => {
    expect(
      shouldOpenReview({
        manuallyOpened: true,
        review: review(),
        sessionRunning: true,
      }),
    ).toBe(true);
  });

  it("still refuses to open a panel nobody opened, mid-turn", () => {
    expect(
      shouldOpenReview({
        manuallyOpened: false,
        review: review(),
        sessionRunning: true,
      }),
    ).toBe(false);
  });

  it("keeps it open across a turn that has not reported changes yet", () => {
    expect(
      shouldOpenReview({
        manuallyOpened: true,
        review: review({ changedThisTurn: false }),
        sessionRunning: true,
      }),
    ).toBe(true);
  });
});

const access = (overrides: Partial<FileAccess> = {}): FileAccess => ({
  agent: { id: "main", label: "Main" },
  at: "2026-01-01T10:00:00.000Z",
  callId: "call-1",
  confidence: "exact",
  id: "call-1",
  kind: "write",
  missing: false,
  path: "src/a.ts",
  project: "semla",
  ranges: [],
  tool: "edit",
  turnId: "u1",
  ...overrides,
});

describe("openingWrite", () => {
  it("ignores reads, which are most of what an agent does", () => {
    // Forty reads to answer a question changed nothing. A panel appearing for
    // each would be closed once and never read again.
    expect(
      openingWrite([access({ kind: "read" }), access({ kind: "read" })]),
    ).toBeNull();
  });

  it("takes the newest write", () => {
    expect(
      openingWrite([
        access({ id: "first" }),
        access({ kind: "read", id: "between" }),
        access({ id: "last" }),
      ])?.id,
    ).toBe("last");
  });

  it("skips a write the panel could not show, rather than stopping there", () => {
    // Agents write to /tmp and to files outside every linked project. Treating
    // one as the newest write would open the panel on nothing.
    expect(
      openingWrite([
        access({ id: "openable" }),
        access({ id: "outside", project: null }),
        access({ id: "deleted", missing: true }),
      ])?.id,
    ).toBe("openable");
  });
});

describe("shouldFollowOpen", () => {
  it("opens on a write while following", () => {
    expect(
      shouldFollowOpen({
        dismissedId: null,
        followMode: true,
        write: access(),
      }),
    ).toBe(true);
  });

  it("stays shut with following off", () => {
    expect(
      shouldFollowOpen({ dismissedId: null, followMode: false, write: access() }),
    ).toBe(false);
  });

  // Otherwise the agent's next edit reopens what the operator just closed, and
  // the close button does nothing.
  it("does not reopen on the write it was closed on", () => {
    expect(
      shouldFollowOpen({
        dismissedId: "call-1",
        followMode: true,
        write: access({ id: "call-1" }),
      }),
    ).toBe(false);
  });

  // A boolean would not do: a later edit is a genuinely new event, and the
  // operator closing one panel is not a statement about the next one.
  it("opens again on a later write", () => {
    expect(
      shouldFollowOpen({
        dismissedId: "call-1",
        followMode: true,
        write: access({ id: "call-2" }),
      }),
    ).toBe(true);
  });
});
