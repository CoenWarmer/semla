/**
 * Driven with a fake pty rather than real shells: the behaviour worth pinning
 * is the bookkeeping around the process — replay, the buffer cap, and whether
 * a terminal nobody is watching gets reclaimed — none of which needs a shell to
 * exercise, and all of which would be slow and flaky if it did.
 */
import type { IPty } from "node-pty";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getTerminal,
  killTerminal,
  pushOutput,
  registerTerminal,
  subscribeToTerminal,
  sweepIdleTerminals,
  terminalCount,
} from "@/lib/pi/terminal-store";

type FakePty = IPty & { emitExit: () => void; killed: boolean };

const fakePty = (): FakePty => {
  let onExit: () => void = () => {};
  const pty = {
    emitExit: () => onExit(),
    kill: vi.fn(function (this: FakePty) {
      this.killed = true;
    }),
    killed: false,
    onData: vi.fn(),
    onExit: vi.fn((cb: () => void) => {
      onExit = cb;
    }),
    resize: vi.fn(),
    write: vi.fn(),
  } as unknown as FakePty;
  return pty;
};

/** Drain anything a previous test left behind. */
beforeEach(() => {
  sweepIdleTerminals(Number.MAX_SAFE_INTEGER, 0);
});

describe("registerTerminal", () => {
  it("makes the terminal findable and starts it idle", () => {
    registerTerminal("a", fakePty());

    expect(getTerminal("a")?.id).toBe("a");
    // Nobody has attached yet, so the idle clock is already running — a
    // terminal created by a browser that then vanished must still be reclaimed.
    expect(getTerminal("a")?.idleSince).not.toBeNull();
  });

  it("drops the entry when the shell exits", () => {
    const pty = fakePty();
    registerTerminal("a", pty);

    pty.emitExit();

    expect(getTerminal("a")).toBeUndefined();
  });

  it("tells whoever is attached that the shell ended", () => {
    const pty = fakePty();
    registerTerminal("a", pty);
    const seen: string[] = [];
    subscribeToTerminal("a", (chunk) => seen.push(chunk));

    pty.emitExit();

    // Otherwise the pane simply goes quiet, which looks like a hang.
    expect(seen.join("")).toContain("process exited");
  });
});

describe("subscribeToTerminal", () => {
  it("replays the scrollback before sending anything new", () => {
    const session = registerTerminal("a", fakePty());
    pushOutput(session, "already printed\r\n");

    const seen: string[] = [];
    subscribeToTerminal("a", (chunk) => seen.push(chunk));

    // The point of the replay: reopening the bar shows the shell as it was,
    // not an empty pane waiting for the next keystroke.
    expect(seen).toEqual(["already printed\r\n"]);

    pushOutput(session, "and now this");
    expect(seen).toEqual(["already printed\r\n", "and now this"]);
  });

  it("reports a terminal that is not there", () => {
    const { ok } = subscribeToTerminal("missing", () => {});
    expect(ok).toBe(false);
  });

  it("stops the idle clock while somebody is watching, and restarts it after", () => {
    registerTerminal("a", fakePty());

    const { unsubscribe } = subscribeToTerminal("a", () => {});
    expect(getTerminal("a")?.idleSince).toBeNull();

    unsubscribe();
    expect(getTerminal("a")?.idleSince).not.toBeNull();
  });

  it("keeps the clock stopped until the last watcher leaves", () => {
    registerTerminal("a", fakePty());
    const first = subscribeToTerminal("a", () => {});
    const second = subscribeToTerminal("a", () => {});

    first.unsubscribe();
    expect(getTerminal("a")?.idleSince).toBeNull();

    second.unsubscribe();
    expect(getTerminal("a")?.idleSince).not.toBeNull();
  });
});

describe("the scrollback buffer", () => {
  it("keeps the most recent output and drops the oldest", () => {
    const session = registerTerminal("a", fakePty());

    // A shell can print without end; the buffer is for reattaching, not for
    // keeping a transcript.
    pushOutput(session, "x".repeat(250_000));
    pushOutput(session, "TAIL");

    expect(session.buffer.length).toBeLessThanOrEqual(200_000);
    expect(session.buffer.endsWith("TAIL")).toBe(true);
  });
});

describe("killTerminal", () => {
  it("kills the process and forgets the terminal", () => {
    const pty = fakePty();
    registerTerminal("a", pty);

    expect(killTerminal("a")).toBe(true);
    expect(pty.killed).toBe(true);
    expect(getTerminal("a")).toBeUndefined();
  });

  it("says so when there is nothing to kill", () => {
    expect(killTerminal("missing")).toBe(false);
  });

  it("still forgets a terminal whose kill throws", () => {
    const pty = fakePty();
    pty.kill = vi.fn(() => {
      throw new Error("already gone");
    });
    registerTerminal("a", pty);

    expect(killTerminal("a")).toBe(true);
    expect(getTerminal("a")).toBeUndefined();
  });
});

describe("sweepIdleTerminals", () => {
  it("reclaims one nobody has watched for long enough", () => {
    const pty = fakePty();
    registerTerminal("a", pty);

    // A tab that closed without saying so leaves the shell running otherwise.
    const killed = sweepIdleTerminals(Date.now() + 60 * 60_000);

    expect(killed).toBe(1);
    expect(pty.killed).toBe(true);
    expect(terminalCount()).toBe(0);
  });

  it("leaves one that is being watched, however long it has been open", () => {
    registerTerminal("a", fakePty());
    subscribeToTerminal("a", () => {});

    expect(sweepIdleTerminals(Date.now() + 24 * 60 * 60_000)).toBe(0);
    expect(getTerminal("a")).toBeDefined();
  });

  it("leaves one that has only just been left", () => {
    registerTerminal("a", fakePty());
    const { unsubscribe } = subscribeToTerminal("a", () => {});
    unsubscribe();

    expect(sweepIdleTerminals(Date.now())).toBe(0);
    expect(getTerminal("a")).toBeDefined();
  });
});
