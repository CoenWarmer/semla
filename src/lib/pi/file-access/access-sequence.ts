/**
 * Turning a timeline into the thing the arrows step through.
 *
 * Raw accesses are not steps. An agent paging through a file with four
 * `sed -n` calls made four accesses and did one thing, and stepping through
 * them as four stops — each re-opening the same file a hundred lines further
 * down — is worse than useless. Consecutive accesses to the same file are
 * folded into one stop whose highlight is the union of what was read.
 *
 * Pure and free of React, and free of `node:` imports so the browser can hold
 * it: the arithmetic is index clamping and range merging, which is exactly the
 * kind of thing that is wrong at the boundaries and silent about it.
 */

import type {
  AccessAgent,
  AccessConfidence,
  AccessKind,
  AccessSymbol,
  AccessTool,
  FileAccess,
  LineRange,
} from "./access-types";

/** One stop for the arrows. */
export interface AccessStep {
  /** The id of the first access folded in — stable across refetches. */
  id: string;
  /**
   * Never null, unlike `FileAccess.project`.
   *
   * The file API resolves paths against a session's linked projects and refuses
   * anything outside them, so an access in `node_modules` or an unlinked
   * repository cannot be opened. Those are counted, not made into stops the
   * arrows land on and fail at.
   */
  project: string;
  path: string;
  kind: AccessKind;
  /** Merged and sorted. Empty means the whole file. */
  ranges: LineRange[];
  symbol?: AccessSymbol;
  agent: AccessAgent;
  tool: AccessTool;
  /** `inferred` if any folded access was; a guess taints the stop. */
  confidence: AccessConfidence;
  at: string;
  /** How many raw accesses this stop folds in. */
  count: number;
}

export interface Sequence {
  steps: AccessStep[];
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
}

/**
 * Whether two accesses are the same agent doing the same thing to one file.
 *
 * The agent is part of the identity: two agents reading the same file are two
 * facts, and the pill names whose read each stop was.
 */
const foldsTogether = (a: AccessStep, b: FileAccess) =>
  a.project === b.project &&
  a.path === b.path &&
  a.kind === b.kind &&
  a.agent.id === b.agent.id;

/**
 * Merge overlapping and adjacent ranges.
 *
 * Adjacent as well as overlapping, so `1–40` followed by `41–80` is one
 * highlight rather than two abutting ones with a seam in the gutter. A range
 * running to EOF (`end: null`) absorbs everything at or after its start.
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

const stepFrom = (access: FileAccess, project: string): AccessStep => ({
  agent: access.agent,
  at: access.at,
  confidence: access.confidence,
  count: 1,
  id: access.id,
  kind: access.kind,
  path: access.path,
  project,
  ranges: mergeRanges(access.ranges),
  ...(access.symbol ? { symbol: access.symbol } : {}),
  tool: access.tool,
});

/** The stops for a filtered timeline, oldest first. */
export function buildSequence(
  accesses: readonly FileAccess[],
  filter: SequenceFilter = { agentId: null, turnId: null },
): Sequence {
  const steps: AccessStep[] = [];
  let missing = 0;
  let unlinked = 0;

  for (const access of accesses) {
    if (filter.turnId !== null && access.turnId !== filter.turnId) continue;
    if (filter.agentId !== null && access.agent.id !== filter.agentId) continue;

    if (access.missing) {
      missing += 1;
      continue;
    }

    if (access.project === null) {
      unlinked += 1;
      continue;
    }

    const last = steps[steps.length - 1];
    if (last && foldsTogether(last, access)) {
      last.count += 1;
      // A whole-file access absorbs the ranges around it: once the agent has
      // read all of a file, marking a subset of it says less, not more.
      last.ranges =
        last.ranges.length === 0 || access.ranges.length === 0
          ? []
          : mergeRanges([...last.ranges, ...access.ranges]);
      if (access.confidence === "inferred") last.confidence = "inferred";
      if (!last.symbol && access.symbol) last.symbol = access.symbol;
      continue;
    }

    steps.push(stepFrom(access, access.project));
  }

  return { missing, steps, unlinked };
}

/**
 * Where the editor should scroll for a stop.
 *
 * A symbol's own line beats the range that contains it, and a range's start
 * beats nothing. Null asks for no scroll at all, which leaves the editor's
 * open-on-the-first-hunk behaviour alone — the right landing place for a
 * whole-file write.
 */
export function revealLineFor(step: AccessStep): number | null {
  return step.symbol?.line ?? step.ranges[0]?.start ?? null;
}

/** The line span a stop covers, for the pill's readout. Null for a whole file. */
export function rangeLabel(step: AccessStep): string | null {
  const first = step.ranges[0];
  if (!first) return null;

  const last = step.ranges[step.ranges.length - 1]!;
  if (last.end === null) return `L${first.start}+`;
  if (step.ranges.length === 1 && first.start === last.end) {
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
 * underneath it while a turn runs and shrinks when the scope or agent filter
 * changes, and a null cursor is "not started", which shows the first stop
 * without having navigated anywhere.
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
  steps: readonly AccessStep[],
  selection: { project: string; path: string } | null,
): number | null {
  if (!selection) return null;

  const index = steps.findIndex(
    (step) => step.project === selection.project && step.path === selection.path,
  );

  return index === -1 ? null : index;
}
