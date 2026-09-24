/**
 * Back/forward history of files opened in the review editor pane.
 *
 * Pure state and transitions, in the same style as review-panel-request.ts,
 * so the browser-style rules — opening a file while not at the newest entry
 * discards the forward entries, and stepping back or forward does not push a
 * new entry — have one place to be correct and tested, independent of the
 * hook that wires them to the panel's other navigation.
 *
 * Deliberately does not know about follow mode, scrubber stops, or anything
 * else `use-panel-target.ts` composes: it only ever sees the `FileSelection`
 * each explicit open resolves to. Follow mode's file switches are derived
 * (`followRequest`), not routed through `pushFileHistory`, so they never
 * enter this stack — the wiring in `use-panel-target.ts` is what keeps that
 * true, not this module.
 */

import { sameFile } from "./review-hunk-cursor";
import type { FileSelection } from "./review-changed-files";

export interface FileHistoryState {
  readonly entries: readonly FileSelection[];
  /** Index into `entries` of the file currently open, or -1 when empty. */
  readonly index: number;
}

export const INITIAL_FILE_HISTORY: FileHistoryState = {
  entries: [],
  index: -1,
};

/**
 * Record an explicit open.
 *
 * A no-op when `next` is the file already current — re-selecting the open
 * file (e.g. clicking its own row again) must not grow the stack. Otherwise
 * appends after the current index, dropping any forward entries: standard
 * browser semantics, and the reason a stray "forward" button does not
 * resurrect a file the operator navigated away from on purpose.
 */
export function pushFileHistory(
  state: FileHistoryState,
  next: FileSelection | null,
): FileHistoryState {
  if (!next) return state;

  const current = state.entries[state.index];
  if (current && sameFile(current, next)) return state;

  const entries = [...state.entries.slice(0, state.index + 1), next];
  return { entries, index: entries.length - 1 };
}

export function canGoBack(state: FileHistoryState): boolean {
  return state.index > 0;
}

export function canGoForward(state: FileHistoryState): boolean {
  return state.index >= 0 && state.index < state.entries.length - 1;
}

/**
 * Step back one entry, or return `state` unchanged when there is nowhere to
 * go — the caller can tell the two cases apart with `canGoBack` beforehand,
 * but this never throws or clamps to a different-looking no-op.
 */
export function goBack(state: FileHistoryState): FileHistoryState {
  if (!canGoBack(state)) return state;
  return { ...state, index: state.index - 1 };
}

export function goForward(state: FileHistoryState): FileHistoryState {
  if (!canGoForward(state)) return state;
  return { ...state, index: state.index + 1 };
}

/** The file `goBack`/`goForward` would land on, or null at either end. */
export function currentFileHistoryEntry(
  state: FileHistoryState,
): FileSelection | null {
  return state.entries[state.index] ?? null;
}
