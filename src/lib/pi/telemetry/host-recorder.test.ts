import { describe, expect, it } from "vitest";

import {
  createHostTelemetry,
  HARNESS_RUN_SPAN,
  HARNESS_STEP_SPAN,
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

describe("the prompt excerpt", () => {
  it("records the start of the prompt on the run span", () => {
    const { host, sink } = setup();
    host.turnStarted({ text: "Give me a list of cute animals" });

    expect(
      named(sink, HARNESS_RUN_SPAN)?.attributes["semla.prompt.excerpt"],
    ).toBe("Give me a list of cute animals");
  });

  it("bounds it, because the transcript already holds the whole prompt", () => {
    const { host, sink } = setup();
    host.turnStarted({ text: "x".repeat(5_000) });

    const excerpt = named(sink, HARNESS_RUN_SPAN)?.attributes[
      "semla.prompt.excerpt"
    ];
    // The span file is appended to twice per span and must not become a
    // second copy of the conversation.
    expect(String(excerpt)).toHaveLength(200);
  });

  it("records nothing when no prompt is given", () => {
    const { host, sink } = setup();
    host.turnStarted();

    expect(
      named(sink, HARNESS_RUN_SPAN)?.attributes,
    ).not.toHaveProperty("semla.prompt.excerpt");
  });

  it("is declared, so redaction can find it", async () => {
    const { SEMLA_TELEMETRY_SCHEMA } = await import("@/lib/pi/telemetry/schema");
    const { sensitiveAttributeKeys } = await import(
      "@/lib/pi/telemetry/span-sink"
    );

    // An attribute in no schema is one `sensitive: "drop"` can never find, so
    // it would sit in every persisted trace with the switch unable to touch it.
    expect(sensitiveAttributeKeys([SEMLA_TELEMETRY_SCHEMA])).toContain(
      "pi.harness.run/semla.prompt.excerpt",
    );
  });

  it("is dropped when the sink is told to", async () => {
    const { createSpanSink, sensitiveAttributeKeys } = await import(
      "@/lib/pi/telemetry/span-sink"
    );
    const { SEMLA_TELEMETRY_SCHEMA } = await import("@/lib/pi/telemetry/schema");

    const sink = createSpanSink(SESSION, {
      sensitive: "drop",
      sensitiveKeys: sensitiveAttributeKeys([SEMLA_TELEMETRY_SCHEMA]),
    });
    const host = createHostTelemetry(sink, { piSessionId: "pi-runtime-1" });
    host.turnStarted({ text: "something private" });

    const run = sink.spans().find((s) => s.name === HARNESS_RUN_SPAN);
    expect(run?.attributes).not.toHaveProperty("semla.prompt.excerpt");
    // Everything else still recorded: redaction must not cost the span.
    expect(run?.attributes["pi.session.id"]).toBe("pi-runtime-1");
  });
});

describe("model round trips", () => {
  it("records one span per round trip, under the turn", () => {
    const { clock, host, sink } = setup();
    host.turnStarted();
    host.stepStarted();
    clock.ms += 800;
    host.stepEnded({ cost: 0.01, tokens: 1_200 });

    const step = named(sink, HARNESS_STEP_SPAN);
    expect(step?.parentSpanId).toBe(host.turnSpanId);
    expect(step?.endTimeMs).toBe(1_800);
    expect(step?.attributes["pi.step.kind"]).toBe("assistant");
    expect(step?.attributes["pi.step.outcome"]).toBe("succeeded");
    expect(step?.attributes["gen_ai.usage.total_tokens"]).toBe(1_200);
    expect(step?.attributes["gen_ai.usage.cost"]).toBe(0.01);
  });

  it("numbers the attempts so their order is readable", () => {
    const { host, sink } = setup();
    host.turnStarted();
    for (let i = 0; i < 3; i += 1) {
      host.stepStarted();
      host.stepEnded();
    }

    expect(
      sink
        .spans()
        .filter((s) => s.name === HARNESS_STEP_SPAN)
        .map((s) => s.attributes["pi.step.attempt"]),
    ).toEqual([0, 1, 2]);
  });

  it("records a round trip that reported no usage", () => {
    const { host, sink } = setup();
    host.turnStarted();
    host.stepStarted();
    host.stepEnded();

    const step = named(sink, HARNESS_STEP_SPAN);
    expect(step?.attributes).not.toHaveProperty("gen_ai.usage.total_tokens");
    expect(step?.endTimeMs).not.toBeNull();
  });

  it("ignores a round trip before the turn opened", () => {
    const { host, sink } = setup();
    host.stepStarted();

    expect(sink.spans()).toHaveLength(0);
  });

  it("closes a round trip superseded without an end", () => {
    const { host, sink } = setup();
    host.turnStarted();
    host.stepStarted();
    host.stepStarted();

    const steps = sink.spans().filter((s) => s.name === HARNESS_STEP_SPAN);
    // Two spans, and the abandoned one closed rather than leaked. (The run
    // and turn are still open too, so `counts.open` is not the check here.)
    expect(steps).toHaveLength(2);
    expect(steps[0]?.status.status).toBe("error");
    expect(steps[0]?.endTimeMs).not.toBeNull();
    expect(steps[1]?.endTimeMs).toBeNull();
  });

  it("closes an open round trip when the turn ends", () => {
    const { host, sink } = setup();
    host.turnStarted();
    host.stepStarted();
    host.turnEnded("aborted");

    // Left open, the trace would claim the model is still answering.
    expect(named(sink, HARNESS_STEP_SPAN)?.endTimeMs).not.toBeNull();
    expect(sink.counts.open).toBe(0);
  });

  it("ignores an end with no round trip in flight", () => {
    const { host, sink } = setup();
    host.turnStarted();
    host.stepEnded({ cost: 1, tokens: 1 });

    expect(named(sink, HARNESS_STEP_SPAN)).toBeUndefined();
  });
});
