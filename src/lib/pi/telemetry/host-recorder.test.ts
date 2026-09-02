import { describe, expect, it } from "vitest";

import {
  createHostTelemetry,
  HARNESS_RUN_SPAN,
  HARNESS_TOOL_SPAN,
  HARNESS_TURN_SPAN,
} from "@/lib/pi/telemetry/host-recorder";
import { createSpanSink } from "@/lib/pi/telemetry/span-sink";

const SESSION = "00000000-0000-4000-8000-0000000h0st".replace("h0st", "b0b1");

const setup = (clock = { ms: 1_000 }) => {
  const sink = createSpanSink(SESSION, { now: () => clock.ms });
  const host = createHostTelemetry(sink, { piSessionId: "pi-runtime-1" });
  return { clock, host, sink };
};

const named = (sink: ReturnType<typeof setup>["sink"], name: string) =>
  sink.spans().find((span) => span.name === name);

describe("turnStarted", () => {
  it("opens a run and a turn nested in it", () => {
    const { host, sink } = setup();
    host.turnStarted();

    const run = named(sink, HARNESS_RUN_SPAN);
    const turn = named(sink, HARNESS_TURN_SPAN);

    expect(run?.parentSpanId).toBeNull();
    expect(turn?.parentSpanId).toBe(run?.spanId);
    expect(host.turnSpanId).toBe(turn?.spanId);
  });

  it("carries the attributes pi's schema requires", () => {
    const { host, sink } = setup();
    host.turnStarted();

    // Pi's own keys, not ours: the sink reads sensitivity from the schemas, so
    // an invented key is one redaction would silently miss.
    expect(named(sink, HARNESS_RUN_SPAN)?.attributes).toMatchObject({
      "pi.lane.name": "main",
      "pi.operation.kind": "run",
      "pi.operation.recovery": false,
      "pi.session.id": "pi-runtime-1",
    });
    expect(named(sink, HARNESS_TURN_SPAN)?.attributes).toMatchObject({
      "pi.lane.name": "main",
    });
  });

  it("shares one operation id between the run and the turn", () => {
    const { host, sink } = setup();
    host.turnStarted();

    expect(named(sink, HARNESS_TURN_SPAN)?.attributes["pi.operation.id"]).toBe(
      named(sink, HARNESS_RUN_SPAN)?.attributes["pi.operation.id"],
    );
  });

  it("is idempotent", () => {
    const { host, sink } = setup();
    host.turnStarted();
    host.turnStarted();

    expect(sink.spans()).toHaveLength(2);
  });

  it("has no turn span before it is called", () => {
    const { host } = setup();
    expect(host.turnSpanId).toBeNull();
  });
});

describe("tool spans", () => {
  it("nests a call under the turn and records its outcome", () => {
    const { clock, host, sink } = setup();
    host.turnStarted();
    host.toolStarted("call-1", { name: "read" });
    clock.ms += 20;
    host.toolEnded("call-1", { isError: false });

    const tool = named(sink, HARNESS_TOOL_SPAN);
    expect(tool?.parentSpanId).toBe(host.turnSpanId);
    expect(tool?.attributes["pi.tool.name"]).toBe("read");
    expect(tool?.attributes["pi.tool.call_id"]).toBe("call-1");
    // A string enum in pi's schema, not a boolean.
    expect(tool?.attributes["pi.tool.replay"]).toBe("never");
    expect(tool?.attributes["pi.tool.is_error"]).toBe(false);
    expect(tool?.endTimeMs).toBe(1_020);
    expect(tool?.status.status).toBe("ok");
  });

  it("marks a failed call as an error", () => {
    const { host, sink } = setup();
    host.turnStarted();
    host.toolStarted("call-1", { name: "bash" });
    host.toolEnded("call-1", { isError: true });

    const tool = named(sink, HARNESS_TOOL_SPAN);
    expect(tool?.attributes["pi.tool.is_error"]).toBe(true);
    expect(tool?.status.status).toBe("error");
  });

  it("ignores a call that arrives before the turn opened", () => {
    const { host, sink } = setup();
    host.toolStarted("call-1", { name: "read" });

    // Re-rooting it would draw it as a sibling of the turn rather than a child.
    expect(sink.spans()).toHaveLength(0);
  });

  it("ignores an end for a call it never saw start", () => {
    const { host, sink } = setup();
    host.turnStarted();
    host.toolEnded("never-started", { isError: false });

    expect(named(sink, HARNESS_TOOL_SPAN)).toBeUndefined();
  });

  it("closes an abandoned call when the turn ends", () => {
    const { host, sink } = setup();
    host.turnStarted();
    host.toolStarted("call-1", { name: "read" });
    host.turnEnded("aborted");

    const tool = named(sink, HARNESS_TOOL_SPAN);
    // Left open, the trace would claim the tool is still running.
    expect(tool?.endTimeMs).not.toBeNull();
    expect(tool?.status.status).toBe("error");
    expect(sink.counts.open).toBe(0);
  });
});

describe("turnEnded", () => {
  it("records the outcome on the run span", () => {
    const { host, sink } = setup();
    host.turnStarted();
    host.turnEnded("completed");

    // The turn span declares no end attributes at all, which is the whole
    // reason a run span exists above it.
    expect(named(sink, HARNESS_RUN_SPAN)?.attributes["pi.operation.outcome"]).toBe(
      "completed",
    );
    expect(sink.counts.open).toBe(0);
  });

  it("records a failure with its error type", () => {
    const { host, sink } = setup();
    host.turnStarted();
    host.turnEnded("failed", { code: "provider timed out", type: "TimeoutError" });

    const run = named(sink, HARNESS_RUN_SPAN);
    expect(run?.attributes["pi.operation.outcome"]).toBe("failed");
    expect(run?.attributes["pi.error.type"]).toBe("TimeoutError");
    expect(run?.status.status).toBe("error");
    expect(named(sink, HARNESS_TURN_SPAN)?.status.status).toBe("error");
  });

  it("is safe to call twice", () => {
    const { clock, host, sink } = setup();
    host.turnStarted();
    host.turnEnded("completed");
    const closedAt = named(sink, HARNESS_TURN_SPAN)?.endTimeMs;
    clock.ms += 500;
    host.turnEnded("failed");

    // A dropped stream and a thrown turn reach the same finally.
    expect(named(sink, HARNESS_TURN_SPAN)?.endTimeMs).toBe(closedAt);
  });

  it("is safe for a turn that never started", () => {
    const { host, sink } = setup();
    expect(() => host.turnEnded("completed")).not.toThrow();
    expect(sink.spans()).toHaveLength(0);
  });
});
