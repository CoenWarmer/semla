/**
 * The shells the console bar is attached to.
 *
 * Shaped after session-stream-store.ts, which solves the same problem for the
 * agent's event stream: an in-process map, and a subscribe that replays what
 * has already been said before attaching. That replay is what lets the bar be
 * collapsed and reopened onto the same shell with its scrollback intact, rather
 * than onto a blank pane.
 *
 * Three things it needs that the session store does not:
 *
 *  - **A capped buffer.** A session's event stream ends; a shell can print
 *    forever, and an unbounded buffer would be a slow leak per terminal.
 *  - **Killing.** A subscriber going away leaves a real process behind. The
 *    idle sweep is what stops a closed tab costing a shell until the server
 *    restarts.
 *  - **Somewhere the dev server cannot lose it.** Module state is discarded on
 *    HMR, which for a Map of processes means orphans nobody can reach or kill,
 *    so it hangs off globalThis instead.
 */

import { existsSync } from "node:fs";

import type { IPty } from "node-pty";

import { PI_WORKSPACE_ROOT } from "@/lib/pi/runtime-config";

/** Scrollback held per terminal. Enough to reattach onto, not a transcript. */
const MAX_BUFFER_CHARS = 200_000;

/** How long a terminal may sit with nobody watching before it is killed. */
export const IDLE_TIMEOUT_MS = 30 * 60_000;

export type TerminalSubscriber = (chunk: string) => void;

export type TerminalSession = {
  id: string;
  pty: IPty;
  /** Recent output, replayed to whoever attaches next. */
  buffer: string;
  subscribers: Set<TerminalSubscriber>;
  /** When the last subscriber left, or null while somebody is watching. */
  idleSince: number | null;
  exited: boolean;
};

/**
 * Survives the module reload that `next dev` performs on every edit. Without
 * this, each reload starts an empty map while the shells from the previous one
 * keep running with nothing able to reach them.
 */
const globalStore = globalThis as unknown as {
  __semlaTerminals?: Map<string, TerminalSession>;
};

const terminals = (globalStore.__semlaTerminals ??= new Map());

/** Where a new shell starts. */
export function terminalCwd(): string {
  // PI_WORKSPACE_ROOT defaults to /workspace outside host development, which is
  // the container's bind mount and simply absent when the server runs anywhere
  // else. Starting in a directory that is not there fails the spawn.
  return existsSync(PI_WORKSPACE_ROOT) ? PI_WORKSPACE_ROOT : process.cwd();
}

/** The shell to run, honouring the user's own. */
export function terminalShell(): string {
  return process.env.SHELL || "/bin/bash";
}

export function getTerminal(id: string): TerminalSession | undefined {
  return terminals.get(id);
}

export function terminalCount(): number {
  return terminals.size;
}

/**
 * Record output and fan it out.
 *
 * Exported for the store's own tests, which drive it with a fake pty rather
 * than spawning real shells.
 */
export function pushOutput(session: TerminalSession, chunk: string): void {
  session.buffer = (session.buffer + chunk).slice(-MAX_BUFFER_CHARS);
  for (const subscriber of session.subscribers) subscriber(chunk);
}

export function registerTerminal(id: string, pty: IPty): TerminalSession {
  const session: TerminalSession = {
    buffer: "",
    exited: false,
    id,
    idleSince: Date.now(),
    pty,
    subscribers: new Set(),
  };

  terminals.set(id, session);
  pty.onData((chunk) => pushOutput(session, chunk));
  pty.onExit(() => {
    session.exited = true;
    // Tell whoever is attached before dropping the entry, so the browser can
    // say the shell ended rather than simply going quiet.
    for (const subscriber of session.subscribers) {
      subscriber("\r\n\u001b[2m[process exited]\u001b[0m\r\n");
    }
    terminals.delete(id);
  });

  return session;
}

/**
 * Attach to a terminal, receiving its scrollback first.
 *
 * The replay is the point: a reader that only saw new output would show an
 * empty pane until the shell happened to print something.
 */
export function subscribeToTerminal(
  id: string,
  onChunk: TerminalSubscriber,
): { unsubscribe: () => void; ok: boolean } {
  const session = terminals.get(id);
  if (!session) return { ok: false, unsubscribe: () => {} };

  if (session.buffer) onChunk(session.buffer);
  session.subscribers.add(onChunk);
  session.idleSince = null;

  return {
    ok: true,
    unsubscribe: () => {
      session.subscribers.delete(onChunk);
      // Start the idle clock only once nobody is left watching.
      if (session.subscribers.size === 0) session.idleSince = Date.now();
    },
  };
}

export function killTerminal(id: string): boolean {
  const session = terminals.get(id);
  if (!session) return false;

  terminals.delete(id);
  try {
    session.pty.kill();
  } catch {
    // Already gone. The entry is removed either way, which is what matters.
  }
  return true;
}

/**
 * Kill terminals nobody has watched for a while.
 *
 * A browser that closes without saying so — a crashed tab, a lost network —
 * otherwise leaves a shell running until the server stops.
 */
export function sweepIdleTerminals(
  now = Date.now(),
  timeoutMs = IDLE_TIMEOUT_MS,
): number {
  let killed = 0;
  for (const [id, session] of terminals) {
    if (session.idleSince !== null && now - session.idleSince >= timeoutMs) {
      killTerminal(id);
      killed += 1;
    }
  }
  return killed;
}
