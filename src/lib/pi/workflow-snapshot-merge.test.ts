import assert from "node:assert/strict";
import { test } from "vitest";

import { mergeLiveSnapshot, type LiveSnapshot } from "./workflow-snapshot-merge.ts";
import type { PersistedRunState } from "./workflow-run-reader.ts";

const T0 = "2026-08-24T12:00:00.000Z";

function live(
  agents: Array<Partial<LiveSnapshot["agents"][number]>>,
): LiveSnapshot {
  return {
    agentCount: agents.length,
    agents: agents.map((agent, i) => ({
      id: i + 1,
      label: `agent-${i + 1}`,
      status: "running",
      ...agent,
    })),
    doneCount: 0,
    errorCount: 0,
    name: "codebase_audit",
    phases: ["Individual Checks"],
    runningCount: agents.length,
  };
}

function disk(agents: PersistedRunState["agents"]): PersistedRunState {
  return {
    agents,
    phases: ["Individual Checks"],
    runId: "run-1",
    startedAt: T0,
    status: "running",
    updatedAt: T0,
    workflowName: "codebase_audit",
  };
}

// Regression: the manager carries no timestamps, so taking it verbatim left
// every live agent with no startedAt/endedAt. The timeline then fell back to
// synthetic bounds and drew a finished agent as a 1ms sliver.
test("takes agent timing from the run file, status from the manager", () => {
  const merged = mergeLiveSnapshot({
    disk: disk([
      {
        endedAt: "2026-08-24T12:00:30.000Z",
        id: 1,
        label: "agent-1",
        prompt: "p",
        startedAt: "2026-08-24T12:00:05.000Z",
        status: "done",
      },
    ]),
    live: live([{ status: "done" }]),
    now: () => "2026-08-24T12:05:00.000Z",
    runId: "merge-timing",
  });

  assert.equal(merged.agents[0].startedAt, "2026-08-24T12:00:05.000Z");
  assert.equal(merged.agents[0].endedAt, "2026-08-24T12:00:30.000Z");
  assert.equal(merged.agents[0].status, "done");
});

test("a running agent absent from disk still gets a start time", () => {
  const merged = mergeLiveSnapshot({
    disk: null,
    live: live([{ status: "running" }]),
    now: () => "2026-08-24T12:00:10.000Z",
    runId: "merge-firstseen",
  });

  assert.equal(merged.agents[0].startedAt, "2026-08-24T12:00:10.000Z");
  // Still running, so no end: the timeline extends the bar to the live clock.
  assert.equal(merged.agents[0].endedAt, undefined);
});

test("the first-seen start is remembered, not advanced on later polls", () => {
  const args = {
    disk: null,
    live: live([{ status: "running" }]),
    runId: "merge-stable",
  };

  const first = mergeLiveSnapshot({ ...args, now: () => "2026-08-24T12:00:10.000Z" });
  const second = mergeLiveSnapshot({ ...args, now: () => "2026-08-24T12:00:40.000Z" });

  assert.equal(second.agents[0].startedAt, first.agents[0].startedAt);
});

test("an agent that finishes without ever reaching disk gets an end time", () => {
  const runId = "merge-terminal";
  mergeLiveSnapshot({
    disk: null,
    live: live([{ status: "running" }]),
    now: () => "2026-08-24T12:00:10.000Z",
    runId,
  });

  const merged = mergeLiveSnapshot({
    disk: null,
    live: live([{ status: "error", error: "boom" }]),
    now: () => "2026-08-24T12:00:25.000Z",
    runId,
  });

  assert.equal(merged.agents[0].startedAt, "2026-08-24T12:00:10.000Z");
  assert.equal(merged.agents[0].endedAt, "2026-08-24T12:00:25.000Z");
});

// Per-agent cost only exists under the agent's own tokenUsage. The manager
// reports it once the agent settles; before that the disk record is the only
// source, so dropping either side left the usage readout priceless.
test("agent cost comes from the manager, falling back to the run file", () => {
  const fromLive = mergeLiveSnapshot({
    disk: disk([
      { id: 1, label: "agent-1", prompt: "p", status: "done", tokenUsage: { cost: 0.5 } },
    ]),
    live: live([{ status: "done", tokenUsage: { cost: 0.25 } }]),
    now: () => T0,
    runId: "merge-cost-live",
  });
  assert.equal(fromLive.agents[0].cost, 0.25);

  const fromDisk = mergeLiveSnapshot({
    disk: disk([
      { id: 1, label: "agent-1", prompt: "p", status: "done", tokenUsage: { cost: 0.5 } },
    ]),
    live: live([{ status: "done" }]),
    now: () => T0,
    runId: "merge-cost-disk",
  });
  assert.equal(fromDisk.agents[0].cost, 0.5);

  const neither = mergeLiveSnapshot({
    disk: null,
    live: live([{ status: "running" }]),
    now: () => T0,
    runId: "merge-cost-none",
  });
  assert.equal(neither.agents[0].cost, undefined);
});

test("run-level startedAt prefers disk, else the earliest agent start", () => {
  const withDisk = mergeLiveSnapshot({
    disk: disk([]),
    live: live([{ status: "running" }]),
    now: () => "2026-08-24T12:09:00.000Z",
    runId: "merge-run-disk",
  });
  assert.equal(withDisk.startedAt, T0);

  const withoutDisk = mergeLiveSnapshot({
    disk: null,
    live: live([{ status: "running" }]),
    now: () => "2026-08-24T12:09:00.000Z",
    runId: "merge-run-nodisk",
  });
  assert.equal(withoutDisk.startedAt, "2026-08-24T12:09:00.000Z");
});
