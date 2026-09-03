/**
 * The recorder's job is to turn paired callbacks into a tree that closes. Two
 * things can go wrong and neither shows up as a wrong number: a span left open
 * forever, and a span attached to the wrong parent because two runs were in
 * flight at once.
 *
 * So most of what follows is about spans *ending*, and about runs not bleeding
 * into each other.
 */
import { describe, expect, it } from "vitest";

import {
  WORKFLOW_AGENT_SPAN,
  WORKFLOW_PHASE_SPAN,
  WORKFLOW_RUN_SPAN,
} from "./schema.ts";
import { createSpanSink, type SpanSink } from "./span-sink.ts";
import { createWorkflowTelemetry } from "./workflow-recorder.ts";

const SESSION = "00000000-0000-4000-8000-00000000dead";

const setup = () => {
  const sink = createSpanSink(SESSION);
  return { sink, telemetry: createWorkflowTelemetry(sink) };
};

const byName = (sink: SpanSink, name: string) =>
  sink.spans().filter((span) => span.name === name);

const named = (sink: SpanSink, label: string) =>
  sink
    .spans()
    .find((span) => span.attributes["semla.workflow.agent.label"] === label);

describe("the tree", () => {
  it("nests phase under run and agent under phase", () => {
    const { sink, telemetry } = setup();

    telemetry.runStarted("r1", { background: false, name: "review" });
    telemetry.phaseStarted("r1", "Review");
    telemetry.agentStarted("r1", { callId: "c1", id: 1, label: "review:bugs" });
    telemetry.agentEnded("r1", { callId: "c1", status: "done" });
    telemetry.runEnded("r1", { status: "completed" });

    const run = byName(sink, WORKFLOW_RUN_SPAN)[0]!;
    const phase = byName(sink, WORKFLOW_PHASE_SPAN)[0]!;
    const agent = byName(sink, WORKFLOW_AGENT_SPAN)[0]!;

    expect(run.parentSpanId).toBeNull();
    expect(phase.parentSpanId).toBe(run.spanId);
    expect(agent.parentSpanId).toBe(phase.spanId);
  });

  /** §8.4: the run hangs off the turn that started it. */
  it("parents the run to a turn span when given one", () => {
    const { sink, telemetry } = setup();

    telemetry.runStarted("r1", {
      background: true,
      name: "review",
      parentSpanId: "aaaaaaaaaaaaaaaa",
    });

    expect(byName(sink, WORKFLOW_RUN_SPAN)[0]?.parentSpanId).toBe(
      "aaaaaaaaaaaaaaaa",
    );
  });

  // A workflow need not call phase() at all.
  it("puts agents under the run when there are no phases", () => {
    const { sink, telemetry } = setup();

    telemetry.runStarted("r1", { background: false, name: "w" });
    telemetry.agentStarted("r1", { callId: "c1", id: 1, label: "solo" });

    expect(byName(sink, WORKFLOW_PHASE_SPAN)).toEqual([]);
    expect(named(sink, "solo")?.parentSpanId).toBe(
      byName(sink, WORKFLOW_RUN_SPAN)[0]?.spanId,
    );
  });

  it("ends the previous phase when the next begins", () => {
    const { sink, telemetry } = setup();

    telemetry.runStarted("r1", { background: false, name: "w" });
    telemetry.phaseStarted("r1", "First");
    telemetry.phaseStarted("r1", "Second");

    const [first, second] = byName(sink, WORKFLOW_PHASE_SPAN);
    expect(first?.endTimeMs).not.toBeNull();
    expect(second?.endTimeMs).toBeNull();
    expect(first?.attributes["semla.workflow.phase.index"]).toBe(0);
    expect(second?.attributes["semla.workflow.phase.index"]).toBe(1);
  });
});

/**
 * Concurrency is the case that would produce a plausible-looking wrong tree: a
 * background run and a foreground one share a manager, and nested workflow()
 * calls add more.
 */
describe("concurrent runs", () => {
  it("keeps two runs' agents apart", () => {
    const { sink, telemetry } = setup();

    telemetry.runStarted("r1", { background: false, name: "a" });
    telemetry.runStarted("r2", { background: true, name: "b" });
    telemetry.phaseStarted("r1", "A");
    telemetry.phaseStarted("r2", "B");
    telemetry.agentStarted("r1", { callId: "c1", id: 1, label: "in-a" });
    telemetry.agentStarted("r2", { callId: "c1", id: 1, label: "in-b" });

    const phaseA = byName(sink, WORKFLOW_PHASE_SPAN).find(
      (s) => s.attributes["semla.workflow.phase.title"] === "A",
    );
    const phaseB = byName(sink, WORKFLOW_PHASE_SPAN).find(
      (s) => s.attributes["semla.workflow.phase.title"] === "B",
    );

    expect(named(sink, "in-a")?.parentSpanId).toBe(phaseA?.spanId);
    expect(named(sink, "in-b")?.parentSpanId).toBe(phaseB?.spanId);
  });

  // Agent ids are per-run, so the same id in two runs is two different agents.
  it("does not let one run's agentEnded close another's agent", () => {
    const { sink, telemetry } = setup();

    telemetry.runStarted("r1", { background: false, name: "a" });
    telemetry.runStarted("r2", { background: false, name: "b" });
    telemetry.agentStarted("r1", { callId: "c1", id: 1, label: "in-a" });
    telemetry.agentStarted("r2", { callId: "c1", id: 1, label: "in-b" });

    telemetry.agentEnded("r1", { callId: "c1", status: "done" });

    expect(named(sink, "in-a")?.endTimeMs).not.toBeNull();
    expect(named(sink, "in-b")?.endTimeMs).toBeNull();
  });

  it("ending one run leaves the other open", () => {
    const { sink, telemetry } = setup();

    telemetry.runStarted("r1", { background: false, name: "a" });
    telemetry.runStarted("r2", { background: false, name: "b" });
    telemetry.runEnded("r1", { status: "completed" });

    const [a, b] = byName(sink, WORKFLOW_RUN_SPAN);
    expect(a?.endTimeMs).not.toBeNull();
    expect(b?.endTimeMs).toBeNull();
  });
});

/** A span left open is a trace that claims work is still running. */
describe("everything closes", () => {
  it("leaves nothing open after a clean run", () => {
    const { sink, telemetry } = setup();

    telemetry.runStarted("r1", { background: false, name: "w" });
    telemetry.phaseStarted("r1", "One");
    telemetry.agentStarted("r1", { callId: "c1", id: 1, label: "a" });
    telemetry.agentEnded("r1", { callId: "c1", status: "done" });
    telemetry.phaseStarted("r1", "Two");
    telemetry.agentStarted("r1", { callId: "c2", id: 2, label: "b" });
    telemetry.agentEnded("r1", { callId: "c2", status: "done" });
    telemetry.runEnded("r1", { status: "completed" });

    expect(sink.counts.open).toBe(0);
    expect(sink.counts.recorded).toBe(5);
  });

  /**
   * An agent still open when the run ends was abandoned — an abort, or a crash
   * between its start and end. It must not stay open, and it must not read as
   * successful.
   */
  it("closes an abandoned agent as an error when the run ends", () => {
    const { sink, telemetry } = setup();

    telemetry.runStarted("r1", { background: false, name: "w" });
    telemetry.agentStarted("r1", { callId: "c1", id: 1, label: "abandoned" });
    telemetry.runEnded("r1", { status: "aborted" });

    expect(sink.counts.open).toBe(0);
    expect(named(sink, "abandoned")?.status).toMatchObject({
      status: "error",
      error: { name: "AgentAbandoned" },
    });
  });

  it("closes an open phase when the run ends", () => {
    const { sink, telemetry } = setup();

    telemetry.runStarted("r1", { background: false, name: "w" });
    telemetry.phaseStarted("r1", "One");
    telemetry.runEnded("r1", { status: "completed" });

    expect(sink.counts.open).toBe(0);
  });

  /**
   * A run id is reused on resume. The previous span is closed rather than
   * orphaned, so a resumed run reads as two spans — which is what happened.
   */
  it("closes the previous run when the same id starts again", () => {
    const { sink, telemetry } = setup();

    telemetry.runStarted("r1", { background: false, name: "w" });
    telemetry.agentStarted("r1", { callId: "c1", id: 1, label: "first-pass" });
    telemetry.runStarted("r1", { background: false, name: "w" });

    expect(byName(sink, WORKFLOW_RUN_SPAN)).toHaveLength(2);
    expect(sink.counts.open).toBe(1);
    expect(named(sink, "first-pass")?.endTimeMs).not.toBeNull();
  });
});

/**
 * A manager reloaded mid-run has live agents whose run span belongs to a
 * process that is gone. Every method has to tolerate that rather than throw
 * into the workflow.
 */
describe("callbacks for a run it never saw", () => {
  it("ignores them all without throwing", () => {
    const { sink, telemetry } = setup();

    expect(() => {
      telemetry.phaseStarted("ghost", "One");
      telemetry.agentStarted("ghost", { callId: "c1", id: 1, label: "a" });
      telemetry.agentEnded("ghost", { callId: "c1", status: "done" });
      telemetry.runEnded("ghost", { status: "completed" });
    }).not.toThrow();

    expect(sink.spans()).toEqual([]);
  });

  it("ignores an agentEnded for an agent it never started", () => {
    const { sink, telemetry } = setup();
    telemetry.runStarted("r1", { background: false, name: "w" });

    expect(() =>
      telemetry.agentEnded("r1", { callId: "c99", status: "done" }),
    ).not.toThrow();
    expect(byName(sink, WORKFLOW_AGENT_SPAN)).toEqual([]);
  });
});

describe("attributes", () => {
  it("records what the run ended with", () => {
    const { sink, telemetry } = setup();

    telemetry.runStarted("r1", { background: true, name: "review" });
    telemetry.runEnded("r1", {
      agentCount: 4,
      doneCount: 3,
      errorCount: 1,
      status: "failed",
    });

    const run = byName(sink, WORKFLOW_RUN_SPAN)[0]!;
    expect(run.attributes).toMatchObject({
      "semla.workflow.agent_count": 4,
      "semla.workflow.background": true,
      "semla.workflow.done_count": 3,
      "semla.workflow.error_count": 1,
      "semla.workflow.name": "review",
      "semla.workflow.run_id": "r1",
      "semla.workflow.status": "failed",
    });
    expect(run.status).toMatchObject({ status: "error" });
  });

  it("records an agent's spend and turns", () => {
    const { sink, telemetry } = setup();

    telemetry.runStarted("r1", { background: false, name: "w" });
    telemetry.agentStarted("r1", {
      callId: "c1",
      id: 1,
      label: "a",
      model: "openrouter/anthropic/claude-sonnet-5",
      prompt: "do the thing",
    });
    telemetry.agentEnded("r1", {
      callId: "c1",
      cost: 0.42,
      status: "done",
      totalTokens: 1234,
      turns: 3,
    });

    expect(named(sink, "a")?.attributes).toMatchObject({
      "semla.workflow.agent.cost": 0.42,
      "semla.workflow.agent.model": "openrouter/anthropic/claude-sonnet-5",
      "semla.workflow.agent.prompt": "do the thing",
      "semla.workflow.agent.status": "done",
      "semla.workflow.agent.total_tokens": 1234,
      "semla.workflow.agent.turns": 3,
    });
  });

  it("omits optional attributes rather than writing undefined", () => {
    const { sink, telemetry } = setup();

    telemetry.runStarted("r1", { background: false, name: "w" });
    telemetry.agentStarted("r1", { callId: "c1", id: 1, label: "a" });
    telemetry.agentEnded("r1", { callId: "c1", status: "done" });

    expect(Object.keys(named(sink, "a")?.attributes ?? {})).toEqual([
      "semla.workflow.agent.call_id",
      "semla.workflow.agent.id",
      "semla.workflow.agent.label",
      "semla.workflow.agent.status",
    ]);
  });

  it("counts the agents a phase ran", () => {
    const { sink, telemetry } = setup();

    telemetry.runStarted("r1", { background: false, name: "w" });
    telemetry.phaseStarted("r1", "One");
    telemetry.agentStarted("r1", { callId: "c1", id: 1, label: "a" });
    telemetry.agentStarted("r1", { callId: "c2", id: 2, label: "b" });
    telemetry.phaseStarted("r1", "Two");

    expect(
      byName(sink, WORKFLOW_PHASE_SPAN)[0]?.attributes[
        "semla.workflow.phase.agent_count"
      ],
    ).toBe(2);
  });

  it("marks a failed agent's span as an error", () => {
    const { sink, telemetry } = setup();

    telemetry.runStarted("r1", { background: false, name: "w" });
    telemetry.agentStarted("r1", { callId: "c1", id: 1, label: "a" });
    telemetry.agentEnded("r1", { callId: "c1", status: "error" });

    expect(named(sink, "a")?.status).toMatchObject({
      status: "error",
      error: { name: "AgentFailed" },
    });
  });
});

describe("where a run hangs from", () => {
  const sinkFor = () => createSpanSink("00000000-0000-4000-8000-00000000aa01");

  it("uses the resolver's answer for a foreground run", () => {
    const sink = sinkFor();
    const telemetry = createWorkflowTelemetry(sink, ({ background, fallback }) =>
      background ? fallback : "tool-span-1",
    );

    telemetry.runStarted("r", {
      background: false,
      name: "wf",
      parentSpanId: "turn-span-1",
    });

    // Inside the tool call that started it, not beside it.
    expect(sink.spans()[0]?.parentSpanId).toBe("tool-span-1");
  });

  it("keeps a background run under the turn", () => {
    const sink = sinkFor();
    const telemetry = createWorkflowTelemetry(sink, ({ background, fallback }) =>
      background ? fallback : "tool-span-1",
    );

    telemetry.runStarted("r", {
      background: true,
      name: "wf",
      parentSpanId: "turn-span-1",
    });

    // The tool call returns as soon as the run is dispatched, so nesting a
    // long run inside it would be a worse lie than the sibling was.
    expect(sink.spans()[0]?.parentSpanId).toBe("turn-span-1");
  });

  it("falls back to the manager's parent with no resolver", () => {
    const sink = sinkFor();
    const telemetry = createWorkflowTelemetry(sink);

    telemetry.runStarted("r", {
      background: false,
      name: "wf",
      parentSpanId: "turn-span-1",
    });

    expect(sink.spans()[0]?.parentSpanId).toBe("turn-span-1");
  });
});
