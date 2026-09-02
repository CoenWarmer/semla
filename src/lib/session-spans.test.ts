import { describe, expect, it } from "vitest";

import type { RecordedSpan } from "@/lib/pi/telemetry/span-sink";
import { mergeSpans } from "./session-spans.ts";

const span = (over: Partial<RecordedSpan> & { spanId: string }): RecordedSpan => ({
  attributes: {},
  endTimeMs: 10,
  events: [],
  name: over.spanId,
  parentSpanId: null,
  startTimeMs: 0,
  status: { status: "ok" },
  traceId: "t",
  ...over,
});

describe("mergeSpans", () => {
  it("prefers the live copy of a span on both sides", () => {
    const persisted = [span({ endTimeMs: null, spanId: "a" })];
    const live = new Map([["a", span({ endTimeMs: 99, spanId: "a" })]]);

    // The file is behind the stream for a turn still running: it holds the
    // span as it was when last flushed.
    expect(mergeSpans(persisted, live)).toEqual([
      span({ endTimeMs: 99, spanId: "a" }),
    ]);
  });

  it("keeps spans that exist on only one side", () => {
    const merged = mergeSpans(
      [span({ spanId: "old" })],
      new Map([["new", span({ spanId: "new" })]]),
    );

    expect(merged.map((s) => s.spanId).sort()).toEqual(["new", "old"]);
  });

  it("returns start order across both sources", () => {
    const merged = mergeSpans(
      [span({ spanId: "second", startTimeMs: 200 })],
      new Map([["first", span({ spanId: "first", startTimeMs: 100 })]]),
    );

    // Concatenating would put the live one last regardless of when it ran.
    expect(merged.map((s) => s.spanId)).toEqual(["first", "second"]);
  });

  it("handles either side being empty", () => {
    expect(mergeSpans([], new Map())).toEqual([]);
    expect(mergeSpans([span({ spanId: "a" })], new Map())).toHaveLength(1);
    expect(mergeSpans([], new Map([["a", span({ spanId: "a" })]]))).toHaveLength(1);
  });
});
