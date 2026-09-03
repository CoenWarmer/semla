/**
 * The bar's button used to read `snapshot.agentCount + 1`, where `snapshot` is
 * the *latest* run — so a session with two workflows reported only the second
 * one's agents while the panel it opens draws all of them.
 */
import { describe, expect, it } from "vitest";

import { countSessionAgents } from "./session-agent-counts.ts";
import type { WorkflowAgentStatus, WorkflowSnapshot } from "@/types/workflow";

const agent = (id: number, status: WorkflowAgentStatus) => ({
  id,
  label: `agent ${id}`,
  status,
});

const run = (runId: string, statuses: WorkflowAgentStatus[]): WorkflowSnapshot => ({
  agentCount: statuses.length,
  agents: statuses.map((status, index) => agent(index, status)),
  doneCount: statuses.filter((s) => s === "done").length,
  errorCount: 0,
  name: runId,
  phases: [],
  runId,
  runningCount: statuses.filter((s) => s === "running").length,
});

describe("countSessionAgents", () => {
  it("counts the session's own agent when nothing else has run", () => {
    // The thing answering prompts is an agent too, and the timeline gives it
    // a row.
    expect(countSessionAgents({})).toEqual({ idle: 1, running: 0 });
  });

  it("counts the session agent as running while a turn is in flight", () => {
    expect(countSessionAgents({ sessionRunning: true })).toEqual({
      idle: 0,
      running: 1,
    });
  });

  it("adds up every run in the session, not just the latest", () => {
    const first = run("r1", ["done", "done"]);
    const second = run("r2", ["done", "running"]);

    expect(
      countSessionAgents({
        snapshot: second,
        workflowRuns: [{ snapshot: second }, { snapshot: first }],
      }),
    ).toEqual({ idle: 4, running: 1 });
  });

  it("does not count a run twice when it is both live and polled", () => {
    const live = run("r1", ["running", "done"]);

    expect(
      countSessionAgents({ snapshot: live, workflowRuns: [{ snapshot: live }] }),
    ).toEqual({ idle: 2, running: 1 });
  });

  it("prefers the live snapshot of a run over the polled one", () => {
    // The polled copy of a background run lags: it still shows both agents
    // queued where the live one has one of them running.
    const polled = run("r1", ["queued", "queued"]);
    const live = run("r1", ["running", "done"]);

    expect(
      countSessionAgents({ snapshot: live, workflowRuns: [{ snapshot: polled }] }),
    ).toEqual({ idle: 2, running: 1 });
  });

  it("counts a run the poll has not seen yet", () => {
    const live = run("r1", ["running"]);

    expect(countSessionAgents({ snapshot: live, workflowRuns: [] })).toEqual({
      idle: 1,
      running: 1,
    });
  });

  it("treats queued as not running", () => {
    // A green dot against work that has not begun would be a lie.
    expect(
      countSessionAgents({ workflowRuns: [{ snapshot: run("r1", ["queued", "queued"]) }] }),
    ).toEqual({ idle: 3, running: 0 });
  });

  it("counts a failed agent among the ones no longer working", () => {
    expect(
      countSessionAgents({ workflowRuns: [{ snapshot: run("r1", ["error", "done"]) }] }),
    ).toEqual({ idle: 3, running: 0 });
  });

  it("ignores runs with no snapshot", () => {
    expect(
      countSessionAgents({ workflowRuns: [{ snapshot: null }] }),
    ).toEqual({ idle: 1, running: 0 });
  });

  it("ignores a snapshot with no run id", () => {
    // What the synthetic single-agent snapshot looks like for a session that
    // ran no workflow; its agent is the session's own, counted separately.
    const synthetic = { ...run("x", ["done"]), runId: undefined };

    expect(countSessionAgents({ snapshot: synthetic })).toEqual({
      idle: 1,
      running: 0,
    });
  });
});
