import { describe, expect, it } from "vitest";

import {
  clearsDeadStreamLatch,
  shouldReconnect,
  type ReconnectConditions,
} from "@/lib/session-reconnect";

const idle: ReconnectConditions = {
  serverIsRunning: false,
  isPending: false,
  isReconnecting: false,
  streamKnownDead: false,
};

describe("shouldReconnect", () => {
  it("does not reattach when the server reports nothing running", () => {
    expect(shouldReconnect(idle)).toBe(false);
  });

  it("reattaches when the server is running and nothing is arriving here", () => {
    // The case the mechanism exists for: a stream that went away mid-turn.
    expect(shouldReconnect({ ...idle, serverIsRunning: true })).toBe(true);
  });

  it("leaves a live stream alone while this page's own submit is in flight", () => {
    expect(
      shouldReconnect({ ...idle, serverIsRunning: true, isPending: true }),
    ).toBe(false);
  });

  it("does not stack a second reattach on one already under way", () => {
    expect(
      shouldReconnect({ ...idle, serverIsRunning: true, isReconnecting: true }),
    ).toBe(false);
  });

  it("stops asking once told the stream is gone, even while the poll says running", () => {
    // The spin loop: the status cache goes on saying "running" for a few
    // seconds after a turn ends, and without this the effect refires on every
    // settle — eight times in 1.15s in the captured session.
    expect(
      shouldReconnect({
        ...idle,
        serverIsRunning: true,
        streamKnownDead: true,
      }),
    ).toBe(false);
  });
});

describe("clearsDeadStreamLatch", () => {
  it("re-arms when a new turn starts", () => {
    expect(clearsDeadStreamLatch(false, true)).toBe(true);
  });

  it("stays latched while the stale poll keeps reporting the finished turn", () => {
    expect(clearsDeadStreamLatch(true, true)).toBe(false);
  });

  it("does not re-arm merely because the turn stopped", () => {
    expect(clearsDeadStreamLatch(true, false)).toBe(false);
    expect(clearsDeadStreamLatch(false, false)).toBe(false);
  });

  it("re-arms a session that goes quiet and then starts a genuinely new turn", () => {
    // false -> true -> false -> true: the second rise must clear the latch, or
    // one 404 would suppress reattachment for the life of the page.
    expect(clearsDeadStreamLatch(true, false)).toBe(false);
    expect(clearsDeadStreamLatch(false, true)).toBe(true);
  });
});
