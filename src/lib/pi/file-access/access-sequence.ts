/**
 * Turning a timeline into the thing the arrows step through.
 *
 * A step is a tool call, not a folded file access — an `ask_user`, an mcp
 * call, or a `bash` the shell parser did not recognise is as much a stop in
 * the agent's work as a `read` is, once the "All tools" filter asks to see
 * it. A call that touched a file contributes one stop per access it made, in
 * order, grouped under that call for the pill to render together; a call
 * that touched nothing contributes exactly one stop, with no file to show and
 * no reason to move the editor.
 *
 * Pure and free of React, and free of `node:` imports so the browser can hold
 * it: the arithmetic is index clamping and array slicing, which is exactly the
 * kind of thing that is wrong at the boundaries and silent about it.
 */

import type { FileAccess, LineRange, ToolCallStep } from "./access-types";

/** One stop for the arrows. */
export type ScrubberStop =
  | { kind: "tool"; id: string; call: ToolCallStep }
  | { kind: "file"; id: string; call: ToolCallStep; access: FileAccess };

export interface Sequence {
  stops: ScrubberStop[];
  /**
   * Accesses left out because the file is no longer on disk.
   *
   * Reported rather than silently dropped: "the agent read four files that
   * have since been deleted" is worth knowing, and an arrow that opens a 404
   * is not.
   */
  missing: number;
  /** Accesses left out because they are outside every linked project. */
  unlinked: number;
}

export interface SequenceFilter {
  /** Null scopes to the whole session. */
  turnId: string | null;
  /** Null includes every agent. */
  agentId: string | null;
  /**
   * Include a call that touched no file as its own stop. Off by default: the
   * pill's long-standing scope is "what the agent read and wrote", and this
   * widens it only when the operator asks to see everything.
   */
  showAllTools: boolean;
}

const DEFAULT_FILTER: SequenceFilter = {
  agentId: null,
  showAllTools: false,
  turnId: null,
};

/**
 * Merge overlapping and adjacent ranges.
 *
 * Adjacent as well as overlapping, so `1–40` followed by `41–80` is one
 * highlight rather than two abutting ones with a seam in the gutter. A range
 * running to EOF (`end: null`) absorbs everything at or after its start.
 *
 * Only ever needed on one access's own `ranges` — no extractor produces more
 * than one range per access — but kept general and exported, since
 * `access-sequence.test.ts` exercises it directly and a future extractor may
 * yet produce several.
 */
export function mergeRanges(ranges: readonly LineRange[]): LineRange[] {
  if (ranges.length === 0) return [];

  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: LineRange[] = [{ ...sorted[0]! }];

  for (const range of sorted.slice(1)) {
    const last = merged[merged.length - 1]!;

    if (last.end === null) continue;
    if (range.start > last.end + 1) {
      merged.push({ ...range });
      continue;
    }

    last.end = range.end === null ? null : Math.max(last.end, range.end);
  }

  return merged;
}

/**
 * The lines of a file these ranges do not cover.
 *
 * Mathematical, and therefore the opposite of the `FileAccess` convention one
 * layer up: there an empty `ranges` means *the whole file*, whereas here it
 * covers nothing and everything comes back as outside it. A caller holding an
 * access has to check for that itself, or it will dim every line of a file the
 * agent read all of.
 *
 * `end: null` is a range running to EOF, so nothing after it is outside.
 */
export function linesOutside(
  ranges: readonly LineRange[],
  lineCount: number,
): LineRange[] {
  if (lineCount < 1) return [];

  const outside: LineRange[] = [];
  let cursor = 1;

  for (const range of mergeRanges(ranges)) {
    const start = Math.max(1, range.start);
    if (start > cursor) {
      outside.push({ end: Math.min(start - 1, lineCount), start: cursor });
    }

    if (range.end === null) return outside;

    cursor = Math.max(cursor, range.end + 1);
    if (cursor > lineCount) return outside;
  }

  if (cursor <= lineCount) outside.push({ end: lineCount, start: cursor });
  return outside;
}

/** The stops for a filtered timeline, oldest first. */
export function buildSequence(
  calls: readonly ToolCallStep[],
  filter: SequenceFilter = DEFAULT_FILTER,
): Sequence {
  const stops: ScrubberStop[] = [];
  let missing = 0;
  let unlinked = 0;

  for (const call of calls) {
    if (filter.turnId !== null && call.turnId !== filter.turnId) continue;
    if (filter.agentId !== null && call.agent.id !== filter.agentId) continue;

    for (const access of call.accesses) {
      if (access.missing) {
        missing += 1;
        continue;
      }
      if (access.project === null) {
        unlinked += 1;
        continue;
      }

      stops.push({ access, call, id: access.id, kind: "file" });
    }

    // A call with a file access that could not be opened (missing/unlinked)
    // still touched a file, so it does not also become a bare tool stop —
    // that would show the same call twice under "All tools".
    if (call.accesses.length === 0 && filter.showAllTools) {
      stops.push({ call, id: `${call.id}:tool`, kind: "tool" });
    }
  }

  return { missing, stops, unlinked };
}

/**
 * Where the editor should scroll for a stop.
 *
 * A symbol's own line beats the range that contains it, and a range's start
 * beats nothing. Null asks for no scroll at all — the right answer both for a
 * whole-file write and for a bare tool stop, which has no file to scroll to.
 */
export function revealLineFor(stop: ScrubberStop): number | null {
  if (stop.kind === "tool") return null;
  return stop.access.symbol?.line ?? stop.access.ranges[0]?.start ?? null;
}

/** The line span a stop covers, for the pill's readout. Null for a whole file or a bare tool stop. */
export function rangeLabel(stop: ScrubberStop): string | null {
  if (stop.kind === "tool") return null;

  const { ranges } = stop.access;
  const first = ranges[0];
  if (!first) return null;

  const last = ranges[ranges.length - 1]!;
  if (last.end === null) return `L${first.start}+`;
  if (ranges.length === 1 && first.start === last.end) {
    return `L${first.start}`;
  }

  return `L${first.start}\u2013${last.end}`;
}

/** Keep an index inside a sequence that may have grown or shrunk under it. */
export function clampIndex(index: number, length: number): number {
  if (length === 0) return 0;
  return Math.min(Math.max(index, 0), length - 1);
}

/**
 * Which stop the pill is on.
 *
 * Following pins to the newest stop, which is the whole of what following
 * means here: the panel is already showing the agent's latest access, and a
 * counter that kept reading its own cursor would name a different file from
 * the one on screen.
 *
 * Otherwise the operator's cursor decides, clamped — the sequence grows
 * underneath it while a turn runs and shrinks when the scope, agent filter or
 * "All tools" toggle changes, and a null cursor is "not started", which shows
 * the first stop without having navigated anywhere.
 */
export function stepIndex({
  cursor,
  following,
  length,
}: {
  cursor: number | null;
  following: boolean;
  length: number;
}): number {
  return clampIndex(following ? length - 1 : (cursor ?? 0), length);
}

/** The stop the file at `selection` is at, for keeping the pill in sync. */
export function indexOfFile(
  stops: readonly ScrubberStop[],
  selection: { project: string; path: string } | null,
): number | null {
  if (!selection) return null;

  const index = stops.findIndex(
    (stop) =>
      stop.kind === "file" &&
      stop.access.project === selection.project &&
      stop.access.path === selection.path,
  );

  return index === -1 ? null : index;
}

/**
 * The contiguous run of stops belonging to the same tool call as `stops[index]`.
 *
 * A call's stops are always contiguous — `buildSequence` emits them as one
 * run per call — so this is a scan, not a search. The pill uses it to render
 * every file badge a call produced together, with the arrow's current index
 * marking which one is active.
 */
export function siblingsOf(
  stops: readonly ScrubberStop[],
  index: number,
): { start: number; end: number } {
  if (index < 0 || index >= stops.length) return { end: -1, start: -1 };

  const callId = stops[index]!.call.id;
  let start = index;
  while (start > 0 && stops[start - 1]!.call.id === callId) start -= 1;
  let end = index;
  while (end < stops.length - 1 && stops[end + 1]!.call.id === callId) end += 1;

  return { end, start };
}
