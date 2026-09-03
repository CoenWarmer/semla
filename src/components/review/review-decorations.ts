/**
 * Turning a file's hunks into the decorations that colour it.
 *
 * Kept apart from the editor component and free of any Monaco import so the
 * mapping can be tested without a DOM: given hunks, which lines and which
 * characters within them get marked. The component's remaining job is to hand
 * these to Monaco, which is the part a test could not meaningfully assert.
 *
 * Columns are 1-based here, because that is what Monaco ranges use, while the
 * spans arriving from the diff are 0-based offsets. Converting once at this
 * boundary is why nothing downstream has to remember which convention it is in.
 */

import type { Hunk } from "@/lib/review-types";

export type DecorationKind =
  /** A line the turn added or rewrote. */
  | "added-line"
  /** The characters within such a line that actually differ. */
  | "added-span"
  /**
   * Where lines were removed. The content is not in the file any more, so
   * there is no line to tint — the marker sits on the line that now occupies
   * the position, and says how many went.
   */
  | "removed-marker";

export interface Decoration {
  kind: DecorationKind;
  startLine: number;
  endLine: number;
  /** 1-based, or null for a whole-line decoration. */
  startColumn: number | null;
  endColumn: number | null;
  /** Lines removed at this point, for the marker's tooltip. Zero otherwise. */
  removedCount: number;
}

const wholeLine = (line: number, kind: DecorationKind): Decoration => ({
  endColumn: null,
  endLine: line,
  kind,
  removedCount: 0,
  startColumn: null,
  startLine: line,
});

/**
 * Every decoration for one file's diff.
 *
 * Removed lines are gathered per run and reported against the line that
 * follows them, which is where the operator's eye goes looking for what left.
 * A run at the end of the file has no following line, so it attaches to the
 * last one — clamped by the caller against the model, since a diff read a
 * moment ago may describe a file the operator has since edited.
 */
export function buildDecorations(hunks: readonly Hunk[]): Decoration[] {
  const decorations: Decoration[] = [];

  for (const hunk of hunks) {
    let pendingRemoved = 0;

    for (const line of hunk.lines) {
      if (line.kind === "removed") {
        pendingRemoved += 1;
        continue;
      }

      if (pendingRemoved > 0 && line.newLine !== null) {
        decorations.push({
          ...wholeLine(line.newLine, "removed-marker"),
          removedCount: pendingRemoved,
        });
        pendingRemoved = 0;
      }

      if (line.kind !== "added" || line.newLine === null) continue;

      decorations.push(wholeLine(line.newLine, "added-line"));

      for (const span of line.spans) {
        decorations.push({
          endColumn: span.end + 1,
          endLine: line.newLine,
          kind: "added-span",
          removedCount: 0,
          startColumn: span.start + 1,
          startLine: line.newLine,
        });
      }
    }

    // A run of removals with nothing after it: the lines went from the end of
    // the hunk, so the marker belongs on the last line the hunk still has.
    if (pendingRemoved > 0) {
      const lastKept = [...hunk.lines]
        .reverse()
        .find((line) => line.newLine !== null);

      decorations.push({
        ...wholeLine(lastKept?.newLine ?? Math.max(1, hunk.newStart), "removed-marker"),
        removedCount: pendingRemoved,
      });
    }
  }

  return decorations;
}

/** The first line worth scrolling to: where the change starts. */
export function firstChangedLine(hunks: readonly Hunk[]): number | null {
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind !== "context" && line.newLine !== null) return line.newLine;
    }
    // A hunk of pure removals still has a position worth going to.
    if (hunk.lines.some((line) => line.kind === "removed")) return hunk.newStart;
  }
  return null;
}
