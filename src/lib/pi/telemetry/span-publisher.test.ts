/**
 * A span reaches the client when it opens and again when it closes. Sending
 * the whole trace on every change would be O(n²) bytes for exactly the long
 * runs that already cost the most — §8.3 settled on no cap, so "the whole
 * trace" has no bound.
 */
import { describe, expect, it, vi } from "vitest";

import { createSpanPublisher } from "./span-publisher.ts";
import { createSpanSink, type RecordedSpan } from "./span-sink.ts";

const span = (
  spanId: string,
  endTimeMs: number | null = null,
): RecordedSpan => ({
  attributes: {},
  endTimeMs,
  events: [],
  name: "s",
  parentSpanId: null,
  spanId,
  startTimeMs: 0,
  status: { status: "ok" },
  traceId: "t",
});

const ids = (spans: readonly RecordedSpan[]) => spans.map((s) => s.spanId);

describe("createSpanPublisher", () => {
  it("sends a new open span once", () => {
    const publisher = createSpanPublisher();

    expect(ids(publisher.pending([span("a")]))).toEqual(["a"]);
    expect(publisher.pending([span("a")])).toEqual([]);
  });

  it("sends it again when it closes, and then no more", () => {
    const publisher = createSpanPublisher();
    publisher.pending([span("a")]);

    expect(ids(publisher.pending([span("a", 10)]))).toEqual(["a"]);
    expect(publisher.pending([span("a", 10)])).toEqual([]);
  });

  // No reason to show it running first if it was never seen running.
  it("sends a span that opened and closed between flushes only once", () => {
    const publisher = createSpanPublisher();

    expect(ids(publisher.pending([span("a", 10)]))).toEqual(["a"]);
    expect(publisher.pending([span("a", 10)])).toEqual([]);
  });

  it("sends each span at most twice, however often it is flushed", () => {
    const publisher = createSpanPublisher();
    let sent = 0;

    for (let i = 0; i < 20; i++) sent += publisher.pending([span("a")]).length;
    for (let i = 0; i < 20; i++) {
      sent += publisher.pending([span("a", 10)]).length;
    }

    expect(sent).toBe(2);
  });

  it("only owes the ones that changed", () => {
    const publisher = createSpanPublisher();
    publisher.pending([span("a"), span("b")]);

    expect(ids(publisher.pending([span("a", 5), span("b"), span("c")]))).toEqual(
      ["a", "c"],
    );
  });

  /** A reconnecting client is a fresh reader over the same sink. */
  it("owes everything again to a new publisher", () => {
    const spans = [span("a", 1), span("b")];
    const first = createSpanPublisher();
    first.pending(spans);

    expect(ids(createSpanPublisher().pending(spans))).toEqual(["a", "b"]);
  });

  it("is harmless when a flush races another", () => {
    const publisher = createSpanPublisher();
    const spans = [span("a")];

    expect(publisher.pending(spans)).toHaveLength(1);
    expect(publisher.pending(spans)).toHaveLength(0);
  });
});

/** The pairing with the sink, since that is what actually drives it. */
describe("against a real sink", () => {
  it("notifies on open and on close, and nothing else", async () => {
    const onChange = vi.fn();
    const sink = createSpanSink("s", { onChange });

    const handle = sink.openSpan({ name: "a" });
    expect(onChange).toHaveBeenCalledTimes(1);

    handle.setAttributes({ x: 1 });
    handle.addEvent("e");
    expect(onChange).toHaveBeenCalledTimes(1);

    handle.close();
    expect(onChange).toHaveBeenCalledTimes(2);

    // Idempotent close must not notify again.
    handle.close();
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("does not notify for a span the cap refused", () => {
    const onChange = vi.fn();
    const sink = createSpanSink("s", { maxSpans: 0, onChange });

    sink.openSpan({ name: "a" }).close();

    expect(onChange).not.toHaveBeenCalled();
  });

  /** A listener that throws must not become the reason a turn failed. */
  it("survives a listener that throws", async () => {
    const sink = createSpanSink("s", {
      onChange: () => {
        throw new Error("listener exploded");
      },
    });

    await expect(sink.startSpan({ name: "a" }, () => "value")).resolves.toBe(
      "value",
    );
    expect(sink.spans()).toHaveLength(1);
  });

  it("delivers a whole run in two passes", async () => {
    const sink = createSpanSink("s");
    const publisher = createSpanPublisher();

    const outer = sink.openSpan({ name: "outer" });
    const inner = sink.openSpan({ name: "inner", parentSpanId: outer.spanId });
    expect(publisher.pending(sink.spans())).toHaveLength(2);

    inner.close();
    outer.close();
    expect(publisher.pending(sink.spans())).toHaveLength(2);
    expect(publisher.pending(sink.spans())).toHaveLength(0);
  });
});
