/**
 * A running flag is cleared in a `finally`, which a killed server never
 * reaches — so a record could claim to be running with nothing behind it, and
 * the sidebar would spin forever. The loop it described only ever existed in
 * memory, so whether this process is working on the session settles it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  releaseLiveSession,
  retainLiveSession,
} from "./live-sessions.ts";
import { isSessionActive } from "./session-service.ts";

const session = () => ({ abort: vi.fn().mockResolvedValue(undefined) });

afterEach(() => {
  releaseLiveSession("s1");
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
});
