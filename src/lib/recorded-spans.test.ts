import { describe, expect, it } from "vitest";

import {
  WORKFLOW_AGENT_SPAN,
  WORKFLOW_PHASE_SPAN,
  WORKFLOW_RUN_SPAN,
} from "@/lib/pi/telemetry/schema";
import { createSpanSink } from "@/lib/pi/telemetry/span-sink";
import type { RecordedSpan } from "@/lib/pi/telemetry/span-sink";
import { createWorkflowTelemetry } from "@/lib/pi/telemetry/workflow-recorder";
import {
  coversHostSession,
  recordedSpansToOtelSpans,
  timelineSource,
} from "@/lib/recorded-spans";

const SESSION = "00000000-0000-4000-8000-00000000f00d";

/**
 * The mapper is tested against what the recorder actually produces rather than
 * hand-written spans. A fixture would keep passing after a schema attribute
 * was renamed, which is the one change most likely to break a label.
 */
const recordRun = (clock: { ms: number }) => {
  const sink = createSpanSink(SESSION, { now: () => clock.ms });
  const telemetry = createWorkflowTelemetry(sink);

  telemetry.runStarted("run-1", { background: false, name: "review-changes" });
  clock.ms += 10;
  telemetry.phaseStarted("run-1", "Review");
  clock.ms += 10;
  telemetry.agentStarted("run-1", {
    callId: "call-a",
    id: 0,
    label: "review:bugs",
    model: "anthropic/claude-sonnet-5",
    prompt: "look for bugs",
  });
  telemetry.agentStarted("run-1", { callId: "call-b", id: 1, label: "review:perf" });
  clock.ms += 100;
  telemetry.agentEnded("run-1", {
    callId: "call-a",
    status: "done",
    totalTokens: 4200,
    turns: 3,
  });

  return { sink, telemetry };
};

describe("recordedSpansToOtelSpans", () => {
  it("labels rows from attributes, not from the schema span name", () => {
    const clock = { ms: 1_000 };
    const { sink } = recordRun(clock);

    const names = recordedSpansToOtelSpans(sink.spans(), { now: clock.ms }).map(
      (span) => span.name,
    );

    // Every recorded name is a schema identifier — all three agents would read
    // "semla.workflow.agent" without the attribute lookup.
    expect(names).toEqual([
      "review-changes",
      "Review",
      "review:bugs",
      "review:perf",
    ]);
    expect(names.some((name) => name.startsWith("semla."))).toBe(false);
  });

  it("keeps the recorded parent chain", () => {
    const clock = { ms: 1_000 };
    const { sink } = recordRun(clock);

    const mapped = recordedSpansToOtelSpans(sink.spans(), { now: clock.ms });
    const byId = new Map(mapped.map((span) => [span.spanId, span]));
    const parentNameOf = (name: string) => {
      const span = mapped.find((candidate) => candidate.name === name);
      return span?.parentSpanId ? byId.get(span.parentSpanId)?.name : null;
    };

    expect(parentNameOf("review-changes")).toBe(null);
    expect(parentNameOf("Review")).toBe("review-changes");
    expect(parentNameOf("review:bugs")).toBe("Review");
    expect(parentNameOf("review:perf")).toBe("Review");
  });

  it("draws an open span up to the caller's clock and marks it running", () => {
    const clock = { ms: 1_000 };
    const { sink } = recordRun(clock);
    const now = clock.ms + 500;

    const mapped = recordedSpansToOtelSpans(sink.spans(), { now });
    const running = mapped.find((span) => span.name === "review:perf");
    const finished = mapped.find((span) => span.name === "review:bugs");

    expect(running?.endTimeMs).toBe(now);
    expect(running?.attributes?.["pi.status"]).toBe("running");
    // The one that closed keeps its measured end, and its recorded status.
    expect(finished?.endTimeMs).toBe(1_120);
    expect(finished?.attributes?.["pi.status"]).toBe("done");
  });

  it("gives every agent the run id its transcript is keyed by", () => {
    const clock = { ms: 1_000 };
    const { sink } = recordRun(clock);

    const mapped = recordedSpansToOtelSpans(sink.spans(), { now: clock.ms });
    const agent = mapped.find((span) => span.name === "review:bugs");
    const phase = mapped.find((span) => span.name === "Review");

    // Only the run span records a run id; the click handler needs it on the
    // agent row, two levels down.
    expect(agent?.attributes?.["pi.run_id"]).toBe("run-1");
    expect(agent?.attributes?.["pi.agent_id"]).toBe(0);
    expect(phase?.attributes?.["pi.run_id"]).toBe("run-1");
  });

  it("carries a failure through as an error status", () => {
    const clock = { ms: 1_000 };
    const { sink, telemetry } = recordRun(clock);
    telemetry.agentEnded("run-1", { callId: "call-b", status: "error" });

    const mapped = recordedSpansToOtelSpans(sink.spans(), { now: clock.ms });
    const failed = mapped.find((span) => span.name === "review:perf");

    expect(failed?.status?.code).toBe("ERROR");
    expect(failed?.status?.message).toBe("error");
    expect(failed?.attributes?.["pi.status"]).toBe("error");
  });

  it("colours rows by the kind of work, not by name", () => {
    const clock = { ms: 1_000 };
    const { sink } = recordRun(clock);

    const services = recordedSpansToOtelSpans(sink.spans(), { now: clock.ms }).map(
      (span) => span.resource?.["service.name"],
    );

    expect(services).toEqual(["workflow", "workflow", "agent", "agent"]);
  });

  it("preserves ids so a span keeps its identity across a re-render", () => {
    const clock = { ms: 1_000 };
    const { sink } = recordRun(clock);
    const recorded = sink.spans();

    const mapped = recordedSpansToOtelSpans(recorded, { now: clock.ms });

    expect(mapped.map((span) => span.spanId)).toEqual(
      recorded.map((span) => span.spanId),
    );
    expect(new Set(mapped.map((span) => span.spanId)).size).toBe(mapped.length);
    expect(new Set(mapped.map((span) => span.traceId)).size).toBe(1);
  });

  it("keeps the schema attributes alongside the panel's own", () => {
    const clock = { ms: 1_000 };
    const { sink } = recordRun(clock);

    const mapped = recordedSpansToOtelSpans(sink.spans(), { now: clock.ms });
    const agent = mapped.find((span) => span.name === "review:bugs");

    // The drawer shows raw attributes, which is where the interesting detail
    // is — the compatibility keys are additions, not a replacement.
    expect(agent?.attributes?.["semla.workflow.agent.total_tokens"]).toBe(4200);
    expect(agent?.attributes?.["semla.workflow.agent.model"]).toBe(
      "anthropic/claude-sonnet-5",
    );
    expect(agent?.attributes?.["semla.workflow.agent.prompt"]).toBe(
      "look for bugs",
    );
  });
});

/** Shapes the recorder cannot produce, but a wire format can. */
describe("recordedSpansToOtelSpans on malformed input", () => {
  const span = (over: Partial<RecordedSpan>): RecordedSpan => ({
    attributes: {},
    endTimeMs: 100,
    events: [],
    name: WORKFLOW_AGENT_SPAN,
    parentSpanId: null,
    spanId: "a",
    startTimeMs: 0,
    status: { status: "ok" },
    traceId: "t",
    ...over,
  });

  it("re-roots a span whose parent never arrived", () => {
    const mapped = recordedSpansToOtelSpans([
      span({ parentSpanId: "missing", spanId: "orphan" }),
    ]);

    // Left pointing at a parent that is not in the set, the whole subtree
    // would be dropped from the tree the library builds.
    expect(mapped[0]?.parentSpanId).toBeUndefined();
    expect(mapped).toHaveLength(1);
  });

  it("does not hang on a parent cycle", () => {
    const mapped = recordedSpansToOtelSpans([
      span({ parentSpanId: "b", spanId: "a" }),
      span({ parentSpanId: "a", spanId: "b" }),
    ]);

    expect(mapped).toHaveLength(2);
    expect(mapped[0]?.attributes?.["pi.run_id"]).toBeUndefined();
  });

  it("flattens array attributes and drops undefined ones", () => {
    const mapped = recordedSpansToOtelSpans([
      span({
        attributes: {
          "semla.list": ["a", "b"],
          "semla.missing": undefined,
          "semla.number": 1,
        },
      }),
    ]);

    // The waterfall's attribute type has no array form; joining beats dropping
    // for the tool and model lists these usually are.
    expect(mapped[0]?.attributes?.["semla.list"]).toBe("a, b");
    expect(mapped[0]?.attributes).not.toHaveProperty("semla.missing");
    expect(mapped[0]?.attributes?.["semla.number"]).toBe(1);
  });

  it("falls back to the span name when the label attribute is missing", () => {
    const mapped = recordedSpansToOtelSpans([
      span({ name: WORKFLOW_RUN_SPAN }),
      span({ name: WORKFLOW_PHASE_SPAN, spanId: "b" }),
      span({ name: WORKFLOW_AGENT_SPAN, spanId: "c" }),
      span({ name: "pi.harness.tool", spanId: "d" }),
    ]);

    expect(mapped.map((s) => s.name)).toEqual([
      "Workflow",
      "Phase",
      "Agent",
      "pi.harness.tool",
    ]);
  });
});

describe("coversHostSession", () => {
  it("is false while only workflows are recorded", () => {
    const clock = { ms: 1_000 };
    const { sink } = recordRun(clock);

    // Which is why the panel still defaults to the derived timeline: a
    // recorded trace of workflow spans alone has no conversation in it.
    expect(coversHostSession(sink.spans())).toBe(false);
  });

  it("is true once a host span arrives", () => {
    const sink = createSpanSink(SESSION);
    sink.openSpan({ name: "pi.harness.turn" });

    expect(coversHostSession(sink.spans())).toBe(true);
  });

  it("is false for no spans at all", () => {
    expect(coversHostSession([])).toBe(false);
  });
});

describe("timelineSource", () => {
  const workflowOnly = (() => {
    const clock = { ms: 1_000 };
    return recordRun(clock).sink.spans();
  })();

  const withHost = (() => {
    const sink = createSpanSink(SESSION);
    sink.openSpan({ name: "pi.harness.turn" });
    return sink.spans();
  })();

  it("shows derived when nothing has been recorded", () => {
    expect(timelineSource([], null)).toBe("derived");
  });

  it("shows derived while only workflow spans are recorded", () => {
    expect(timelineSource(workflowOnly, null)).toBe("derived");
  });

  it("prefers recorded once host spans arrive", () => {
    // The point of the predicate: step 6 flips this without a change here.
    expect(timelineSource(withHost, null)).toBe("recorded");
  });

  it("honours an explicit pick either way", () => {
    expect(timelineSource(workflowOnly, "recorded")).toBe("recorded");
    expect(timelineSource(withHost, "derived")).toBe("derived");
  });

  it("ignores a pick of recorded when there is nothing to show", () => {
    // The toggle is hidden in that state, but a stale pick must not render an
    // empty timeline.
    expect(timelineSource([], "recorded")).toBe("derived");
  });
});
