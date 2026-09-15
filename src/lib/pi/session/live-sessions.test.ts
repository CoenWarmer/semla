/**
 * A turn is an agent loop inside this process, so without a handle on the
 * session nothing could interrupt it — a run that had gone wrong could only be
 * waited out or killed with the server, and an orient turn runs for tens of
 * minutes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getLiveSession,
  isSessionLive,
  releaseLiveSession,
  retainLiveSession,
} from "./live-sessions.ts";

const session = () => ({
  abort: vi.fn().mockResolvedValue(undefined),
  compact: vi.fn().mockResolvedValue(undefined),
});

afterEach(() => {
  for (const id of ["s1", "s2"]) {
    const live = getLiveSession(id);
    if (live) releaseLiveSession(id, live);
  }
});

describe("live session registry", () => {
  it("hands back the session that is running a turn", () => {
    const live = session();
    retainLiveSession("s1", live);

    expect(getLiveSession("s1")).toBe(live);
    expect(isSessionLive("s1")).toBe(true);
  });

  it("has nothing for a session that is not running", () => {
    expect(getLiveSession("s2")).toBeUndefined();
    expect(isSessionLive("s2")).toBe(false);
  });

  // The turn ending is what removes it; a stop arriving afterwards finds
  // nothing, which is the honest answer rather than an error.
  it("forgets a session once its turn ends", () => {
    const live = session();
    retainLiveSession("s1", live);

    releaseLiveSession("s1", live);

    expect(isSessionLive("s1")).toBe(false);
  });

  it("keeps sessions apart", () => {
    const first = session();
    const second = session();
    retainLiveSession("s1", first);
    retainLiveSession("s2", second);

    releaseLiveSession("s1", first);

    expect(getLiveSession("s1")).toBeUndefined();
    expect(getLiveSession("s2")).toBe(second);
  });

  it("replaces the handle when a session starts a new turn", () => {
    retainLiveSession("s1", session());
    const newer = session();

    retainLiveSession("s1", newer);

    expect(getLiveSession("s1")).toBe(newer);
  });

  // The guard Phase 1 of docs/plans/superseded-turns.md adds: a superseded
  // turn's own release, arriving after a new turn has already registered,
  // must not clear the new turn's handle.
  it("does not clear a newer turn's handle when an old handle is released late", () => {
    const stale = session();
    retainLiveSession("s1", stale);
    const newer = session();
    retainLiveSession("s1", newer);

    releaseLiveSession("s1", stale);

    expect(getLiveSession("s1")).toBe(newer);
    expect(isSessionLive("s1")).toBe(true);
  });
});
