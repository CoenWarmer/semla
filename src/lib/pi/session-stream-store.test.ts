/**
 * The push transport a background workflow now uses instead of a DB poll:
 * events published while a stream is open reach every current subscriber
 * immediately, and a subscriber that attaches late still learns the session's
 * current state from the buffer rather than nothing at all.
 *
 * See background-continuation.ts, which keeps a session's stream open across
 * the handoff from its originating prompt turn precisely so this store's
 * publish/subscribe pair can carry that turn's completion and a background
 * workflow's progress without a client ever having to ask again.
 */
import { describe, expect, it } from "vitest";

import {
  closeSessionStream,
  isSessionStreamActive,
  openSessionStream,
  publishSessionRunning,
  publishToSessionStream,
  subscribeToSessionStream,
} from "./session-stream-store.ts";

const sessionId = () => `test-session-${Math.random().toString(36).slice(2)}`;

describe("publishToSessionStream / subscribeToSessionStream", () => {
  it("delivers a completion event to a subscriber with no poll involved", () => {
    const id = sessionId();
    openSessionStream(id);

    const received: unknown[] = [];
    const { unsubscribe } = subscribeToSessionStream(id, (event) => {
      received.push(event);
    });

    publishToSessionStream(id, { runId: "run-1", type: "workflow-started" });
    publishToSessionStream(id, { type: "complete" });

    // Nothing here reads a database or a filesystem — the assertion is that
    // the event reached the subscriber purely through the in-memory
    // publish/subscribe pair, synchronously, the instant it was published.
    expect(received).toEqual([
      { runId: "run-1", type: "workflow-started" },
      { type: "complete" },
    ]);

    unsubscribe();
    closeSessionStream(id);
  });

  it("tells a subscriber the stream closed, distinct from a complete event arriving on it", () => {
    const id = sessionId();
    openSessionStream(id);

    let closed = false;
    subscribeToSessionStream(
      id,
      () => {},
      () => {
        closed = true;
      },
    );

    // A "complete" event on its own must not look like a close: a background
    // continuation now keeps the store open past its originating turn's own
    // "complete" while the workflow it is watching keeps running.
    publishToSessionStream(id, { type: "complete" });
    expect(closed).toBe(false);

    closeSessionStream(id);
    expect(closed).toBe(true);
  });

  it("lets a late subscriber learn the session is still running", () => {
    const id = sessionId();
    openSessionStream(id);

    publishSessionRunning(id, true);
    publishToSessionStream(id, { runId: "run-1", type: "workflow-started" });

    // Attaches after both of the above already happened — the case a second
    // tab, or a reload mid-workflow, is in.
    const received: unknown[] = [];
    subscribeToSessionStream(id, (event) => received.push(event));

    expect(received).toEqual([
      { isRunning: true, type: "session-status" },
      { runId: "run-1", type: "workflow-started" },
    ]);

    closeSessionStream(id);
  });

  it("replays only the latest session-status and workflow-snapshot, not every one", () => {
    const id = sessionId();
    openSessionStream(id);

    publishSessionRunning(id, true);
    publishToSessionStream(id, {
      snapshot: { agentCount: 1, doneCount: 0 },
      type: "workflow-snapshot",
    });
    publishToSessionStream(id, {
      snapshot: { agentCount: 1, doneCount: 1 },
      type: "workflow-snapshot",
    });
    // A stream that lives for a background workflow's whole run can receive
    // hundreds of these; without compaction a subscriber attaching near the
    // end would replay every one of them just to learn the last.
    publishSessionRunning(id, false);

    const received: unknown[] = [];
    subscribeToSessionStream(id, (event) => received.push(event));

    expect(received).toEqual([
      { snapshot: { agentCount: 1, doneCount: 1 }, type: "workflow-snapshot" },
      { isRunning: false, type: "session-status" },
    ]);

    closeSessionStream(id);
  });

  it("still buffers every ordinary event in full for a late subscriber", () => {
    const id = sessionId();
    openSessionStream(id);

    publishToSessionStream(id, { roundId: "r1", type: "round-start" });
    publishToSessionStream(id, {
      delta: "hello",
      roundId: "r1",
      type: "assistant-delta",
    });
    publishToSessionStream(id, {
      delta: " world",
      roundId: "r1",
      type: "assistant-delta",
    });

    const received: unknown[] = [];
    subscribeToSessionStream(id, (event) => received.push(event));

    expect(received).toEqual([
      { roundId: "r1", type: "round-start" },
      { delta: "hello", roundId: "r1", type: "assistant-delta" },
      { delta: " world", roundId: "r1", type: "assistant-delta" },
    ]);

    closeSessionStream(id);
  });

  it("reports inactive once closed, and a subscribe after that gets nothing", () => {
    const id = sessionId();
    openSessionStream(id);
    expect(isSessionStreamActive(id)).toBe(true);

    closeSessionStream(id);
    expect(isSessionStreamActive(id)).toBe(false);

    const { isActive, unsubscribe } = subscribeToSessionStream(id, () => {});
    expect(isActive).toBe(false);
    unsubscribe();
  });

  it("publishing to a closed or never-opened stream is a harmless no-op", () => {
    const id = sessionId();
    // Never opened.
    expect(() =>
      publishToSessionStream(id, { type: "complete" }),
    ).not.toThrow();
    expect(() => publishSessionRunning(id, true)).not.toThrow();
  });

  it("reopening an already-open stream keeps the existing subscriber attached", () => {
    // The case a background continuation keeps a stream open across the
    // handoff from its prompt turn, and the session's next prompt calls
    // openSessionStream() again before the continuation has stood down. A
    // subscriber attached to the first open must go on receiving events
    // published after the second call, not be silently orphaned by a fresh
    // buffer/subscriber set replacing the one it is attached to.
    const id = sessionId();
    openSessionStream(id);

    const received: unknown[] = [];
    subscribeToSessionStream(id, (event) => received.push(event));

    // The next prompt's own runPiPrompt calls this again for the same id.
    openSessionStream(id);

    publishToSessionStream(id, { text: "hello again", type: "user-message" });

    expect(received).toEqual([{ text: "hello again", type: "user-message" }]);

    closeSessionStream(id);
  });
});
