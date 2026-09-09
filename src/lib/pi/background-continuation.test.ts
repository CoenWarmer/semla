/**
 * Regression coverage for the outer delivery-timeout race in
 * `runBackgroundContinuation`.
 *
 * The bug: when the 30-minute (`timeoutMs`) race loses — delivery never
 * started, and no new prompt superseded this continuation — the `finally`
 * block runs the full terminal sequence (dispose the session, finalize the
 * run) unconditionally, without checking whether the run it was watching is
 * actually finished. `finalizeBackgroundRun` defaults its `status` argument
 * to `"completed"`, so a run that is still `"running"` gets written to the
 * index as `"completed"` — the one status `fetchStuckBackgroundRuns` never
 * looks for, so the run is unrecoverable from then on.
 *
 * `timeoutMs` is an injectable override (default: the real 30-minute
 * `TIMEOUT_MS`) purely so this test does not need to wait 30 minutes or fight
 * fake timers across a `setInterval` watchdog; no production call site passes
 * it, so real behaviour is unchanged.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { finalizeBackgroundRun, releaseBackgroundSession, readWorkflowRun } =
  vi.hoisted(() => ({
    finalizeBackgroundRun: vi.fn(() => Promise.resolve()),
    releaseBackgroundSession: vi.fn(),
    readWorkflowRun: vi.fn(),
  }));

vi.mock("@/lib/pi/background-sessions", () => ({ releaseBackgroundSession }));
vi.mock("@/lib/pi/bg-continuation-registry", () => ({
  releaseBackgroundContinuation: vi.fn(),
}));
vi.mock("@/lib/pi/entry-persist-queue", () => ({ queueEntries: vi.fn() }));
vi.mock("@/lib/pi/session-persistence", () => ({
  finalizeBackgroundRun,
  persistWorkflowSnapshot: vi.fn(() => Promise.resolve()),
  setSessionRunning: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/pi/session-stream-store", () => ({
  closeSessionStream: vi.fn(),
  publishSessionRunning: vi.fn(),
  publishToSessionStream: vi.fn(),
}));
vi.mock("@/lib/pi/session-wiki-stamp", () => ({ stampWikiRepo: vi.fn() }));
vi.mock("@/lib/pi/workflow-run-reader", () => ({
  isRunTerminal: (run: { status: string } | null) =>
    run !== null && ["aborted", "completed", "failed"].includes(run.status),
  readWorkflowRun,
}));

import type { SessionDebugWriter } from "./debug-writer.ts";
import {
  runBackgroundContinuation,
  type ContinuableSession,
} from "./background-continuation.ts";

const debugStub = () =>
  new Proxy({} as SessionDebugWriter, { get: () => vi.fn() });

const fakeSession = (): ContinuableSession => ({
  agent: { waitForIdle: () => Promise.resolve() },
  dispose: vi.fn(),
  sendCustomMessage: () => Promise.resolve(),
  sessionManager: { getEntries: () => [] },
  subscribe: () => () => {},
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runBackgroundContinuation — delivery timeout", () => {
  it("does not finalize the run as completed, and does not dispose the session, when the run is still running", async () => {
    readWorkflowRun.mockReturnValue({ status: "running" });
    const session = fakeSession();
    const debug = debugStub();

    // No runId, so the watchdog setInterval (which would otherwise poll
    // readWorkflowRun on its own POLL_MS schedule) never starts — this
    // isolates the outer race's own timeout handling.
    await runBackgroundContinuation({
      abortSignal: new AbortController().signal,
      agentCwd: "/w/proj",
      debug,
      piSessionId: "pi-1",
      projects: [],
      runId: "run-1",
      semlaSessionId: "s1",
      session,
      timeoutMs: 5,
    });

    expect(finalizeBackgroundRun).not.toHaveBeenCalledWith(
      "s1",
      "run-1",
      "completed",
    );
    // Bug: today this fires with two args, which session-persistence.ts
    // defaults to status "completed".
    expect(finalizeBackgroundRun).not.toHaveBeenCalled();
    expect(session.dispose).not.toHaveBeenCalled();
    expect(releaseBackgroundSession).not.toHaveBeenCalled();
  });

  it("still runs the terminal sequence when the run really is finished", async () => {
    readWorkflowRun.mockReturnValue({ status: "completed" });
    const session = fakeSession();
    const debug = debugStub();

    await runBackgroundContinuation({
      abortSignal: new AbortController().signal,
      agentCwd: "/w/proj",
      debug,
      piSessionId: "pi-1",
      projects: [],
      runId: "run-2",
      semlaSessionId: "s1",
      session,
      timeoutMs: 5,
    });

    expect(releaseBackgroundSession).toHaveBeenCalledWith("run-2");
    // The status is now explicit (session-persistence.ts no longer defaults
    // it to "completed"), so this really-finished path passes it plainly.
    expect(finalizeBackgroundRun).toHaveBeenCalledWith("s1", "run-2", "completed");
  });
});
