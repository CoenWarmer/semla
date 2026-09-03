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
  foldSingleTurnRuns,
  recordedSpansToOtelSpans,
  timelineSource,
} from "@/lib/recorded-spans";

const SESSION = "00000000-0000-4000-8000-00000000f00d";

/**
 * Just the mapped recorded spans. The session row is synthesised on top and
 * has its own tests; a test about what the recorder produced should not have
 * to look past it.
 */
const withoutSessionRow = <T extends { name: string }>(
  spans: readonly T[],
): T[] => spans.filter((span) => span.name !== "Session");

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

    const names = withoutSessionRow(
      recordedSpansToOtelSpans(sink.spans(), { now: clock.ms }),
    ).map((span) => span.name);

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

    // A workflow run with no turn above it in the recorded set is adopted by
    // the session row, which is the point of that row.
    expect(parentNameOf("review-changes")).toBe("Session");
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

    const services = withoutSessionRow(
      recordedSpansToOtelSpans(sink.spans(), { now: clock.ms }),
    ).map((span) => span.resource?.["service.name"]);

    expect(services).toEqual(["workflow", "workflow", "agent", "agent"]);
  });

  it("preserves ids so a span keeps its identity across a re-render", () => {
    const clock = { ms: 1_000 };
    const { sink } = recordRun(clock);
    const recorded = sink.spans();

    const mapped = recordedSpansToOtelSpans(recorded, { now: clock.ms });
    const real = withoutSessionRow(mapped);

    expect(real.map((span) => span.spanId)).toEqual(
      recorded.map((span) => span.spanId),
    );
    expect(new Set(mapped.map((span) => span.spanId)).size).toBe(mapped.length);
    // The session row belongs to the same trace, so nothing splits.
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
    const orphan = mapped.find((s) => s.spanId === "orphan");

    // Left pointing at a parent that is not in the set, the whole subtree
    // would be dropped from the tree the library builds. Re-rooted, it is
    // then adopted by the session row like any other root.
    expect(orphan?.parentSpanId).toBe(
      mapped.find((s) => s.name === "Session")?.spanId,
    );
    expect(withoutSessionRow(mapped)).toHaveLength(1);
  });

  it("does not hang on a parent cycle", () => {
    const mapped = recordedSpansToOtelSpans([
      span({ parentSpanId: "b", spanId: "a" }),
      span({ parentSpanId: "a", spanId: "b" }),
    ]);

    expect(withoutSessionRow(mapped)).toHaveLength(2);
    expect(withoutSessionRow(mapped)[0]?.attributes?.["pi.run_id"]).toBeUndefined();
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
    const [only] = withoutSessionRow(mapped);
    expect(only?.attributes?.["semla.list"]).toBe("a, b");
    expect(only?.attributes).not.toHaveProperty("semla.missing");
    expect(only?.attributes?.["semla.number"]).toBe(1);
  });

  it("falls back to the span name when the label attribute is missing", () => {
    const mapped = recordedSpansToOtelSpans([
      span({ name: WORKFLOW_RUN_SPAN }),
      span({ name: WORKFLOW_PHASE_SPAN, spanId: "b" }),
      span({ name: WORKFLOW_AGENT_SPAN, spanId: "c" }),
      span({ name: "pi.harness.tool", spanId: "d" }),
    ]);

    expect(withoutSessionRow(mapped).map((s) => s.name)).toEqual([
      "Workflow",
      "Phase",
      "Agent",
      // A host tool span with no `pi.tool.name` still reads as a tool rather
      // than as a schema identifier.
      "⚙ tool",
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

describe("host span labels", () => {
  const hostSpan = (name: string, attributes: Record<string, string> = {}) => ({
    attributes,
    endTimeMs: 5,
    events: [],
    name,
    parentSpanId: null,
    spanId: name,
    startTimeMs: 0,
    status: { status: "ok" as const },
    traceId: "t",
  });

  it("names a tool row after the tool", () => {
    const mapped = recordedSpansToOtelSpans([
      hostSpan("pi.harness.tool", { "pi.tool.name": "bash" }),
    ]);

    // The glyph matches the derived timeline's, so switching source does not
    // change what a tool row looks like.
    const [tool] = withoutSessionRow(mapped);
    expect(tool?.name).toBe("⚙ bash");
    expect(tool?.resource?.["service.name"]).toBe("tool");
  });

  it("gives the turn and its run plain names", () => {
    const mapped = recordedSpansToOtelSpans([
      hostSpan("pi.harness.run"),
      hostSpan("pi.harness.turn"),
    ]);

    expect(withoutSessionRow(mapped).map((s) => s.name)).toEqual([
      "Prompt",
      "Turn",
    ]);
    expect(
      withoutSessionRow(mapped).map((s) => s.resource?.["service.name"]),
    ).toEqual(["session", "session"]);
  });
});

describe("the session row", () => {
  const at = (start: number, end: number | null, over: Partial<RecordedSpan> = {}): RecordedSpan => ({
    attributes: {},
    endTimeMs: end,
    events: [],
    name: "pi.harness.run",
    parentSpanId: null,
    spanId: `${start}`,
    startTimeMs: start,
    status: { status: "ok" },
    traceId: "trace-1",
    ...over,
  });

  it("holds every prompt in one row", () => {
    const mapped = recordedSpansToOtelSpans([at(100, 200), at(500, 900)]);
    const row = mapped.find((span) => span.name === "Session");

    expect(row).toBeDefined();
    expect(row?.parentSpanId).toBeUndefined();
    // Both prompts, which were separate roots, now hang from it.
    expect(
      mapped.filter((span) => span.parentSpanId === row?.spanId),
    ).toHaveLength(2);
  });

  it("spans the extent of what it holds, and nothing more", () => {
    const row = recordedSpansToOtelSpans([at(100, 200), at(500, 900)]).find(
      (span) => span.name === "Session",
    );

    // An envelope over measured spans, not a measurement of its own — which
    // is why it does not breach §8.5's rule against mixing the two.
    expect(row?.startTimeMs).toBe(100);
    expect(row?.endTimeMs).toBe(900);
  });

  it("counts the prompts it holds", () => {
    const row = recordedSpansToOtelSpans([at(1, 2), at(3, 4), at(5, 6)]).find(
      (span) => span.name === "Session",
    );

    expect(row?.attributes?.["semla.session.prompts"]).toBe(3);
  });

  it("reaches to now while a prompt is still running", () => {
    const row = recordedSpansToOtelSpans([at(100, null)], { now: 7_000 }).find(
      (span) => span.name === "Session",
    );

    expect(row?.endTimeMs).toBe(7_000);
  });

  it("keeps a stable id across renders", () => {
    // A new id each render would drop the reader's selection and collapse
    // state every time a span arrived.
    const first = recordedSpansToOtelSpans([at(1, 2)]);
    const second = recordedSpansToOtelSpans([at(1, 2), at(3, 4)]);

    expect(second.find((s) => s.name === "Session")?.spanId).toBe(
      first.find((s) => s.name === "Session")?.spanId,
    );
  });

  it("does not adopt a span that already has a parent", () => {
    // Two children, so the run does not fold — the point here is the session
    // row leaving an existing parent alone.
    const mapped = recordedSpansToOtelSpans([
      at(100, 900),
      at(150, 800, { name: "pi.harness.turn", parentSpanId: "100", spanId: "t" }),
      at(150, 800, { name: "pi.harness.tool", parentSpanId: "100", spanId: "x" }),
    ]);

    const turn = mapped.find((span) => span.name === "Turn");
    expect(turn?.parentSpanId).toBe("100");
  });

  it("adds nothing for an empty trace", () => {
    expect(recordedSpansToOtelSpans([])).toEqual([]);
  });

  it("leaves the tree single-rooted", async () => {
    const { buildSpanTree } = await import("react-otel-trace-waterfall");
    const mapped = recordedSpansToOtelSpans([at(100, 200), at(500, 900)]);

    expect(buildSpanTree([...mapped])).toHaveLength(1);
  });
});

describe("foldSingleTurnRuns", () => {
  const sp = (over: Partial<RecordedSpan> & { spanId: string }): RecordedSpan => ({
    attributes: {},
    endTimeMs: 100,
    events: [],
    name: "pi.harness.run",
    parentSpanId: null,
    startTimeMs: 0,
    status: { status: "ok" },
    traceId: "t",
    ...over,
  });

  const run = (over: Partial<RecordedSpan> = {}) =>
    sp({ attributes: { "pi.operation.outcome": "completed" }, spanId: "r", ...over });
  const turn = (over: Partial<RecordedSpan> = {}) =>
    sp({
      attributes: { "pi.turn.id": "turn-1" },
      name: "pi.harness.turn",
      parentSpanId: "r",
      spanId: "t",
      ...over,
    });

  it("drops the turn and keeps the run", () => {
    const folded = foldSingleTurnRuns([run(), turn()]);

    expect(folded.map((s) => s.name)).toEqual(["pi.harness.run"]);
  });

  it("keeps the run's bounds, so no time is hidden", () => {
    const folded = foldSingleTurnRuns([
      run({ endTimeMs: 2_613 }),
      turn({ endTimeMs: 2_612 }),
    ]);

    // Whatever the run measured is what the row shows. There is no tolerance
    // to tune, which is why the condition is structural rather than numeric.
    expect(folded[0]?.startTimeMs).toBe(0);
    expect(folded[0]?.endTimeMs).toBe(2_613);
  });

  it("carries both spans' attributes", () => {
    const folded = foldSingleTurnRuns([run(), turn()]);

    expect(folded[0]?.attributes).toMatchObject({
      "pi.operation.outcome": "completed",
      "pi.turn.id": "turn-1",
    });
  });

  it("lifts the turn's children onto the run", () => {
    const folded = foldSingleTurnRuns([
      run(),
      turn(),
      sp({ name: "pi.harness.tool", parentSpanId: "t", spanId: "tool" }),
      sp({ name: "semla.workflow.run", parentSpanId: "t", spanId: "wf" }),
    ]);

    // Left pointing at the removed turn, both subtrees would fall out of the
    // tree entirely.
    expect(
      folded.filter((s) => s.parentSpanId === "r").map((s) => s.spanId).sort(),
    ).toEqual(["tool", "wf"]);
    expect(folded.some((s) => s.parentSpanId === "t")).toBe(false);
  });

  it("takes an error from either span", () => {
    const fromTurn = foldSingleTurnRuns([
      run(),
      turn({ status: { status: "error", error: { message: "x", name: "TurnFailed" } } }),
    ]);
    expect(fromTurn[0]?.status.status).toBe("error");

    const fromRun = foldSingleTurnRuns([
      run({ status: { status: "error", error: { message: "x", name: "RunFailed" } } }),
      turn(),
    ]);
    expect(fromRun[0]?.status.status).toBe("error");
  });

  it("leaves a run that holds more than its turn alone", () => {
    // The shape step 7 introduces, by letting pi emit these itself: a run is
    // an operation that can carry compaction and more than one turn.
    const spans = [
      run(),
      turn(),
      sp({ name: "pi.harness.compaction", parentSpanId: "r", spanId: "c" }),
    ];

    expect(foldSingleTurnRuns(spans)).toHaveLength(3);
    expect(foldSingleTurnRuns(spans).map((s) => s.name)).toContain(
      "pi.harness.turn",
    );
  });

  it("leaves a run with two turns alone", () => {
    const spans = [run(), turn(), turn({ spanId: "t2" })];
    expect(foldSingleTurnRuns(spans)).toHaveLength(3);
  });

  it("leaves a run with no turn alone", () => {
    const spans = [run()];
    expect(foldSingleTurnRuns(spans)).toHaveLength(1);
  });

  it("folds each prompt of a multi-prompt session", () => {
    const folded = foldSingleTurnRuns([
      run({ spanId: "r1" }),
      turn({ parentSpanId: "r1", spanId: "t1" }),
      run({ spanId: "r2" }),
      turn({ parentSpanId: "r2", spanId: "t2" }),
    ]);

    expect(folded.map((s) => s.spanId)).toEqual(["r1", "r2"]);
  });

  it("returns the input untouched when there is nothing to fold", () => {
    const spans = [sp({ name: "semla.workflow.run", spanId: "w" })];
    expect(foldSingleTurnRuns(spans)).toEqual(spans);
  });
});
