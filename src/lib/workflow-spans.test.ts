import assert from "node:assert/strict";
import { test } from "vitest";

import type { WorkflowSnapshot } from "@/types/workflow";
import type { SessionMessage } from "@/hooks/use-session-messages";
import { workflowSnapshotToSpans } from "./workflow-spans.ts";

const T0 = Date.parse("2026-08-24T12:00:00.000Z");
const NOW = T0 + 60_000;

const messages = [
  { createdAt: new Date(T0).toISOString(), text: "audit this" },
] as unknown as SessionMessage[];

function snapshot(
  agents: Array<Partial<WorkflowSnapshot["agents"][number]>>,
  extra: Partial<WorkflowSnapshot> = {},
): WorkflowSnapshot {
  return {
    agentCount: agents.length,
    agents: agents.map((a, i) => ({
      id: i + 1,
      label: `agent-${i + 1}`,
      phase: "Individual Checks",
      status: "running",
      ...a,
    })),
    doneCount: 0,
    errorCount: 0,
    name: "codebase_audit",
    phases: ["Individual Checks"],
    runId: "run-1",
    runningCount: agents.length,
    ...extra,
  } as WorkflowSnapshot;
}

/** Width in ms of the span whose name matches. */
function widthOf(spans: ReturnType<typeof workflowSnapshotToSpans>, name: string) {
  const span = spans.find((s) => s.name === name);
  assert.ok(span, `no span named ${name}`);
  const ms = (nano: string) => Number(nano.slice(0, -6));
  return ms(span.endTimeUnixNano) - ms(span.startTimeUnixNano);
}

test("a running agent's bar grows as the clock advances", () => {
  const snap = snapshot([
    { startedAt: new Date(T0 + 10_000).toISOString(), status: "running" },
  ]);

  const early = widthOf(workflowSnapshotToSpans(snap, messages, { now: T0 + 20_000 }), "agent-1");
  const later = widthOf(workflowSnapshotToSpans(snap, messages, { now: T0 + 50_000 }), "agent-1");

  assert.equal(early, 10_000);
  assert.equal(later, 40_000);
  assert.ok(later > early, "running bar should widen as now advances");
});

// Regression: the in-memory manager reports no timestamps, so a finished agent
// used to fall through to `aStart + 1` and render as an invisible 1ms sliver.
// snapshotFromRunFile now supplies a start/end for these, so the bar has to
// reflect the real duration rather than collapsing.
test("a finished agent with timestamps is not collapsed to a sliver", () => {
  const snap = snapshot(
    [
      {
        startedAt: new Date(T0 + 5_000).toISOString(),
        endedAt: new Date(T0 + 35_000).toISOString(),
        status: "done",
      },
    ],
    { doneCount: 1, runningCount: 0 },
  );

  assert.equal(widthOf(workflowSnapshotToSpans(snap, messages, { now: NOW }), "agent-1"), 30_000);
});

test("an errored agent keeps its measured duration", () => {
  const snap = snapshot(
    [
      {
        startedAt: new Date(T0 + 1_000).toISOString(),
        endedAt: new Date(T0 + 4_000).toISOString(),
        status: "error",
        error: "No API key found for the selected model.",
      },
    ],
    { doneCount: 0, errorCount: 1, runningCount: 0 },
  );

  const spans = workflowSnapshotToSpans(snap, messages, { now: NOW });
  assert.equal(widthOf(spans, "agent-1"), 3_000);
  const span = spans.find((s) => s.name === "agent-1");
  assert.equal(span?.status?.code, "ERROR");
});

test("tool calls become EVENT spans under the Tool calls sub-row", () => {
  const spans = workflowSnapshotToSpans(snapshot([]), messages, {
    now: NOW,
    toolCalls: [
      {
        createdAt: new Date(T0 + 2_000).toISOString(),
        id: "toolu_1",
        messageId: "m1",
        name: "bash",
        summary: "npm test",
      },
      {
        createdAt: new Date(T0 + 4_000).toISOString(),
        id: "toolu_2",
        messageId: "m1",
        name: "read",
      },
    ],
  });

  const toolCallsRow = spans.find((s) => s.name === "Tool calls");
  assert.ok(toolCallsRow);

  // Tool calls row is a child of Conversation.
  const conversation = spans.find((s) => s.name === "Conversation");
  assert.ok(conversation);
  assert.equal(toolCallsRow.parentSpanId, conversation.spanId);

  const tools = spans.filter(
    (s) => s.kind === "EVENT" && s.resource?.["service.name"] === "tool",
  );
  assert.deepEqual(
    tools.map((s) => s.name),
    ["⚙ bash: npm test", "⚙ read"],
  );
  for (const tool of tools) {
    assert.equal(tool.parentSpanId, toolCallsRow.spanId);
    // Zero-width: a marker sits on an instant, not a range.
    assert.equal(tool.startTimeUnixNano, tool.endTimeUnixNano);
  }
});

test("a tool call extends the trace past the last message", () => {
  const spans = workflowSnapshotToSpans(snapshot([]), messages, {
    now: NOW,
    toolCalls: [
      {
        createdAt: new Date(T0 + 30_000).toISOString(),
        id: "toolu_1",
        messageId: "m1",
        name: "bash",
      },
    ],
  });

  assert.equal(widthOf(spans, "Session"), 30_000);
});

test("the workflow span spans its agents rather than the whole trace", () => {
  const snap = snapshot(
    [
      {
        startedAt: new Date(T0 + 40_000).toISOString(),
        endedAt: new Date(T0 + 50_000).toISOString(),
        status: "done",
      },
    ],
    {
      doneCount: 1,
      runningCount: 0,
      startedAt: new Date(T0 + 40_000).toISOString(),
      completedAt: new Date(T0 + 50_000).toISOString(),
    },
  );

  const spans = workflowSnapshotToSpans(snap, messages, { now: NOW });
  assert.equal(widthOf(spans, "codebase_audit"), 10_000);
  // The session root still covers the earlier conversation.
  assert.ok(widthOf(spans, "Session") >= 50_000);
});

test("additionalSnapshots each get their own workflow branch under Session", () => {
  // First (failed) run: ran for 3 minutes, hit agent limit.
  const failedRun = snapshot(
    [
      {
        startedAt: new Date(T0 + 5_000).toISOString(),
        endedAt: new Date(T0 + 30_000).toISOString(),
        status: "error",
        error: "Agent limit exceeded (3)",
      },
    ],
    {
      runId: "run-failed",
      name: "codebase_audit",
      doneCount: 0,
      errorCount: 1,
      runningCount: 0,
      startedAt: new Date(T0 + 5_000).toISOString(),
      completedAt: new Date(T0 + 30_000).toISOString(),
    },
  );

  // Second (successful) run: the primary snapshot.
  const successRun = snapshot(
    [
      {
        startedAt: new Date(T0 + 35_000).toISOString(),
        endedAt: new Date(T0 + 55_000).toISOString(),
        status: "done",
      },
    ],
    {
      runId: "run-success",
      name: "codebase_audit",
      doneCount: 1,
      runningCount: 0,
      startedAt: new Date(T0 + 35_000).toISOString(),
      completedAt: new Date(T0 + 55_000).toISOString(),
    },
  );

  const spans = workflowSnapshotToSpans(successRun, messages, {
    now: NOW,
    additionalSnapshots: [failedRun],
  });

  const sessionSpan = spans.find((s) => s.name === "Session");
  assert.ok(sessionSpan);

  // Both workflow branches exist as children of Session (one per runId).
  const wfSpans = spans.filter(
    (s) => s.parentSpanId === sessionSpan.spanId && s.name === "codebase_audit",
  );
  assert.equal(wfSpans.length, 2, "both runs should each produce a workflow branch");

  // The errored agent from the failed run is present with the correct error.
  const errorAgent = spans.find(
    (s) => s.status?.code === "ERROR" && s.attributes?.["pi.run_id"] === "run-failed",
  );
  assert.ok(errorAgent, "errored agent appears in the failed run's branch");
  assert.equal(errorAgent.status?.message, "Agent limit exceeded (3)");

  // The successful agent from the second run is also present.
  const doneAgent = spans.find(
    (s) => s.attributes?.["pi.run_id"] === "run-success" && s.attributes?.["pi.status"] === "done",
  );
  assert.ok(doneAgent, "done agent appears in the successful run's branch");
});
