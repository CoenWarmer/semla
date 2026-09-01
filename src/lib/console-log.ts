"use client";

/**
 * What the console bar shows: an append-only log of what the agent is doing,
 * kept in the browser.
 *
 * A module-level store rather than React state, because the writers and the
 * reader are far apart in the tree — the session component owns the event
 * stream, the bar lives in the root layout — and threading a context between
 * them would put a provider around the whole app for one strip of text.
 *
 * Deliberately generic. It takes lines; it does not know what produces them.
 * Today that is the agent's tool calls, which is all the SSE stream carries;
 * when the stream learns to send a command's actual output, that arrives here
 * without the bar changing at all.
 */

export type ConsoleLine = {
  /** Monotonic within a page load, so React keys are stable. */
  id: number;
  at: string;
  text: string;
  kind: "command" | "result" | "error" | "note";
};

/**
 * Enough to be useful scrolling back, bounded so a long session cannot grow
 * the tab's memory without limit. Older lines fall off the top, as in a real
 * terminal's scrollback.
 */
const MAX_LINES = 500;

let lines: ConsoleLine[] = [];
let nextId = 0;
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

export function appendConsoleLine(
  text: string,
  kind: ConsoleLine["kind"] = "note",
): void {
  nextId += 1;
  const line: ConsoleLine = { at: new Date().toISOString(), id: nextId, kind, text };

  // A new array each time: useSyncExternalStore compares snapshots by identity,
  // and mutating in place would leave the bar showing the first render forever.
  lines = [...lines, line].slice(-MAX_LINES);
  emit();
}

export function clearConsole(): void {
  lines = [];
  emit();
}

export function getConsoleLines(): ConsoleLine[] {
  return lines;
}

export function subscribeToConsole(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Rendered form: one line per entry, prefixed the way a shell would. */
export function formatConsole(entries: readonly ConsoleLine[]): string {
  return entries
    .map((line) => (line.kind === "command" ? `$ ${line.text}` : line.text))
    .join("\n");
}
