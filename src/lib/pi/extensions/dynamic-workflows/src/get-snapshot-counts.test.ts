/**
 * A snapshot read straight off the manager kept the counts it was built with.
 * Three wiki-ingest runs were recorded as "0/0 done" beside five running
 * agents, because only the tool-result path recomputed them on the way out.
 */
import { describe, expect, it } from "vitest";

import { recomputeWorkflowSnapshot, type WorkflowSnapshot } from "./display.ts";

const snapshot = {
  runId: "wiki-ingest-mthbedh0-6rqj81",
  name: "wiki-ingest",
  agents: [
    { id: 1, status: "done" },
    { id: 2, status: "done" },
    { id: 3, status: "running" },
    { id: 4, status: "error" },
  ],
  agentCount: 0,
  doneCount: 0,
  runningCount: 0,
  errorCount: 0,
} as unknown as WorkflowSnapshot;

describe("recomputeWorkflowSnapshot", () => {
  it("derives the counts a stored snapshot left at zero", () => {
    const counted = recomputeWorkflowSnapshot(snapshot);

    expect(counted.agentCount).toBe(4);
    expect(counted.doneCount).toBe(2);
    expect(counted.runningCount).toBe(1);
    expect(counted.errorCount).toBe(1);
  });

  it("leaves the agents themselves untouched", () => {
    expect(recomputeWorkflowSnapshot(snapshot).agents).toBe(snapshot.agents);
  });

  it("reports zeros for a run with no agents yet", () => {
    const empty = recomputeWorkflowSnapshot({ ...snapshot, agents: [] });

    expect(empty.agentCount).toBe(0);
    expect(empty.doneCount).toBe(0);
  });
});
