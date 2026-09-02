/**
 * Where a session's spans survive a page reload.
 *
 * Append-only JSONL, one span per line, beside the session's own transcript in
 * `PI_SESSION_DIR`. Reading folds by span id with the last line winning, which
 * is the same rule the client applies to the spans it receives over the
 * stream — a span is written when it opens and again when it closes, so the
 * closed form overwrites the open one.
 *
 * **Appending rather than rewriting** is the point of the format. §8.3 settled
 * on no cap, so a long run holds thousands of spans; rewriting the whole file
 * on every flush would put O(n²) bytes on the disk for exactly the runs that
 * already cost the most. It is the same reason the wire carries deltas.
 *
 * **Beside the session, not beside the run file.** §8.2 said the run
 * directory, and that was right when the only spans were `semla.workflow.*`.
 * Layer 2a records the turn and its tool calls, so a session with no workflow
 * has a trace and no run file to sit beside, and a session with three runs has
 * one trace spanning all of them. The trace is session-scoped — `traceId` is
 * derived from the session id — so the session's own directory is where the
 * decision's reasoning actually points: alongside the record a reader already
 * knows how to find, disk-first, no migration.
 */

import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";

import { PI_SESSION_DIR } from "@/lib/pi/runtime-config";
import type { RecordedSpan } from "@/lib/pi/telemetry/span-sink";

/** Injectable so tests never write into the real session directory. */
export type SpanStoreOptions = { dir?: string };

export const spanFilePath = (
  sessionId: string,
  dir = PI_SESSION_DIR,
): string => join(dir, `${sessionId}.spans.jsonl`);

/**
 * Append spans as they stand now.
 *
 * Never throws. A session whose spans could not be written is a session with a
 * shorter trace, which is strictly better than a turn that failed because of
 * its own telemetry.
 */
export const appendSpans = async (
  sessionId: string,
  spans: readonly RecordedSpan[],
  options: SpanStoreOptions = {},
): Promise<void> => {
  if (spans.length === 0) return;

  try {
    await appendFile(
      spanFilePath(sessionId, options.dir),
      spans.map((span) => JSON.stringify(span)).join("\n") + "\n",
      "utf8",
    );
  } catch {
    // See the docblock: losing a span must not fail a turn.
  }
};

/**
 * Every span recorded for this session, folded to its latest state.
 *
 * A malformed line is skipped rather than failing the read. These files are
 * appended to while a turn runs, so a reader can legitimately catch a partial
 * final line — and a trace missing its last span beats a panel that cannot
 * draw at all.
 */
export const readSpans = async (
  sessionId: string,
  options: SpanStoreOptions = {},
): Promise<RecordedSpan[]> => {
  let contents: string;
  try {
    contents = await readFile(spanFilePath(sessionId, options.dir), "utf8");
  } catch {
    // No file is the normal case: a session that has recorded nothing.
    return [];
  }

  const byId = new Map<string, RecordedSpan>();

  for (const line of contents.split("\n")) {
    if (!line.trim()) continue;

    let span: RecordedSpan;
    try {
      span = JSON.parse(line) as RecordedSpan;
    } catch {
      continue;
    }

    // Guarded because these come off disk, where a truncated write can still
    // be valid JSON without being a span.
    if (typeof span?.spanId !== "string" || typeof span.name !== "string") {
      continue;
    }

    byId.set(span.spanId, span);
  }

  // Start order, which is what the waterfall and the publisher both assume.
  return [...byId.values()].sort((a, b) => a.startTimeMs - b.startTimeMs);
};
