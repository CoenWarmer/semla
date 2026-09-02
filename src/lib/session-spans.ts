/**
 * The persisted half of a session's trace.
 *
 * Live spans arrive on the turn's stream and exist only for as long as the
 * page does. This is what a reload reads instead, and the two are merged with
 * live winning: for a finished turn they agree, and for a running one the
 * stream is ahead of the file.
 */

import type { RecordedSpan } from "@/lib/pi/telemetry/span-sink";

export const sessionSpansKey = (sessionId: string) =>
  ["session-spans", sessionId] as const;

export const fetchSessionSpans = async (
  sessionId: string,
): Promise<RecordedSpan[]> => {
  const response = await fetch(`/api/sessions/${sessionId}/spans`);
  if (!response.ok) throw new Error("Unable to load session spans.");

  const body = (await response.json()) as { spans?: RecordedSpan[] };
  return body.spans ?? [];
};

/**
 * One span per id, the live copy preferred, in start order.
 *
 * Sorted rather than concatenated because the two sources are separately
 * ordered, and a waterfall row's identity is its id — a span that moved
 * position between renders would otherwise reorder the tree under the reader.
 */
export const mergeSpans = (
  persisted: readonly RecordedSpan[],
  live: ReadonlyMap<string, RecordedSpan>,
): RecordedSpan[] => {
  const byId = new Map<string, RecordedSpan>();

  for (const span of persisted) byId.set(span.spanId, span);
  for (const [id, span] of live) byId.set(id, span);

  return [...byId.values()].sort((a, b) => a.startTimeMs - b.startTimeMs);
};
