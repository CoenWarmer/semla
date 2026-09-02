/**
 * A continuation outlives the turn that armed it, so the registry is what a
 * later prompt — or a stop request — has to reach it through. Getting the
 * handover wrong is invisible until it matters: a session that reports itself
 * idle while a workflow is still running, or a stop that finds nothing.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  abortBackgroundContinuation,
  armBackgroundContinuation,
  hasBackgroundContinuation,
  releaseBackgroundContinuation,
} from "./bg-continuation-registry.ts";

afterEach(() => {
  abortBackgroundContinuation("s1");
});

describe("armBackgroundContinuation", () => {
  it("registers the session and returns a live signal", () => {
    const signal = armBackgroundContinuation("s1");

    expect(hasBackgroundContinuation("s1")).toBe(true);
    expect(signal.aborted).toBe(false);
  });

  it("leaves other sessions alone", () => {
    armBackgroundContinuation("s1");

    expect(hasBackgroundContinuation("s2")).toBe(false);
  });
});

describe("abortBackgroundContinuation", () => {
  it("aborts the signal and deregisters, reporting that it did", () => {
    const signal = armBackgroundContinuation("s1");

    expect(abortBackgroundContinuation("s1")).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(hasBackgroundContinuation("s1")).toBe(false);
  });

  // Every prompt calls this to stand down a predecessor that usually isn't there.
  it("reports false when there was nothing to stand down", () => {
    expect(abortBackgroundContinuation("never-armed")).toBe(false);
  });
});

describe("releaseBackgroundContinuation", () => {
  it("deregisters a continuation tearing itself down", () => {
    const signal = armBackgroundContinuation("s1");

    releaseBackgroundContinuation("s1", signal);

    expect(hasBackgroundContinuation("s1")).toBe(false);
    // Released, not aborted: the continuation is already unwinding.
    expect(signal.aborted).toBe(false);
  });

  /**
   * The handover this identity check exists for. A superseded continuation
   * unwinds while the prompt that superseded it arms its own — and it does so
   * from the same `finally`. An unconditional delete here would leave the new
   * continuation unreachable: `isSessionActive` would call the session idle and
   * a stop request would find nothing to abort.
   */
  it("does not deregister the continuation that replaced it", () => {
    const superseded = armBackgroundContinuation("s1");
    abortBackgroundContinuation("s1");
    const current = armBackgroundContinuation("s1");

    releaseBackgroundContinuation("s1", superseded);

    expect(hasBackgroundContinuation("s1")).toBe(true);
    expect(current.aborted).toBe(false);
  });
});
