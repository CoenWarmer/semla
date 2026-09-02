/**
 * A running flag is cleared in a `finally`, which a killed server never
 * reaches — so a record could claim to be running with nothing behind it, and
 * the sidebar would spin forever. The loop it described only ever existed in
 * memory, so whether this process is working on the session settles it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  abortBackgroundContinuation,
  armBackgroundContinuation,
} from "./bg-continuation-registry.ts";
import {
  releaseLiveSession,
  retainLiveSession,
} from "./live-sessions.ts";
import { isSessionActive } from "./session-service.ts";

const session = () => ({ abort: vi.fn().mockResolvedValue(undefined) });

afterEach(() => {
  releaseLiveSession("s1");
  abortBackgroundContinuation("s1");
});

describe("isSessionActive", () => {
  it("is true while a turn holds the session", () => {
    retainLiveSession("s1", session());

    expect(isSessionActive("s1")).toBe(true);
  });

  it("is false once the turn lets go", () => {
    retainLiveSession("s1", session());
    releaseLiveSession("s1");

    expect(isSessionActive("s1")).toBe(false);
  });

  // The state a restart leaves behind: a record says running, nothing is.
  it("is false for a session this process never started", () => {
    expect(isSessionActive("never-seen")).toBe(false);
  });

  /**
   * The other half, and the reason both are checked. A continuation is armed in
   * the same `finally` that releases the live session, so a session watching a
   * background workflow holds no live session at all — reading only the live
   * registry would call every background run finished and let the stale-flag
   * sweep clear a running one.
   */
  it("is true while a background continuation is watching", () => {
    armBackgroundContinuation("s1");

    expect(isSessionActive("s1")).toBe(true);
  });

  it("is false once the continuation stands down", () => {
    armBackgroundContinuation("s1");
    abortBackgroundContinuation("s1");

    expect(isSessionActive("s1")).toBe(false);
  });
});
