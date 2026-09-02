/**
 * What a turn still owes the client, so the stream carries each span twice
 * rather than the whole trace on every change.
 *
 * `workflow-snapshot` events republish the entire snapshot each time, which is
 * fine because a snapshot is bounded by the agent count. Spans are not: §8.3
 * settled on no cap, so a long orient run can produce thousands, and resending
 * all of them on every agent start would put O(n²) bytes on the wire for a run
 * that is already the expensive kind.
 *
 * A span only needs to reach the client twice. Once when it opens — the panel
 * draws it as running, timing it against its own clock, which is what
 * `workflow-spans.ts` already does with `liveNow`. Then once when it closes,
 * which is also when the recorder sets every end attribute it has. Nothing in
 * between changes what is drawn.
 *
 * Kept separate from the sink because the sink is per session and this is per
 * *reader*: a reconnecting client needs to be told everything again, and that
 * is a fresh publisher over the same sink.
 */

import type { RecordedSpan } from "@/lib/pi/telemetry/span-sink";

export type SpanPublisher = {
  /**
   * Spans whose current state the reader has not seen, marking them sent.
   *
   * Calling this twice with no change between returns nothing the second time,
   * so a flush that races another is harmless.
   */
  pending: (spans: readonly RecordedSpan[]) => RecordedSpan[];
};

export const createSpanPublisher = (): SpanPublisher => {
  const sentOpen = new Set<string>();
  const sentClosed = new Set<string>();

  return {
    pending: (spans) => {
      const owed: RecordedSpan[] = [];

      for (const span of spans) {
        const closed = span.endTimeMs !== null;

        if (!sentOpen.has(span.spanId)) {
          sentOpen.add(span.spanId);
          // A span that opened and closed between two flushes is sent once,
          // already closed — there is no reason to show it running first.
          if (closed) sentClosed.add(span.spanId);
          owed.push(span);
          continue;
        }

        if (closed && !sentClosed.has(span.spanId)) {
          sentClosed.add(span.spanId);
          owed.push(span);
        }
      }

      return owed;
    },
  };
};
