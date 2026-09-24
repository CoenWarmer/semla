import { describe, expect, it } from "vitest";

import type { WorkflowRun } from "@/hooks/use-workflow-runs";
import type { WorkflowSnapshot } from "@/types/workflow";

import {
  persistedRunSnapshot,
  sessionAgentSnapshot,
  sessionPanelSnapshot,
} from "./session-panel-snapshot.ts";

const snapshot = (runId: string, agents: number): WorkflowSnapshot => ({
  agentCount: agents,
  agents: Array.from({ length: agents }, (_, id) => ({
    id,
    label: `agent ${id}`,
    status: "running" as const,
  })),
  doneCount: 0,
  errorCount: 0,
  name: `run ${runId}`,
  phases: [],
  runId,
  runningCount: agents,
});

const run = (runId: string, snap: WorkflowSnapshot | null, status: WorkflowRun["status"] = "running"): WorkflowRun => ({
  created_at: "2026-09-24T10:00:00.000Z",
  error: null,
  mode: "background",
  run_id: runId,
  snapshot: snap,
  status,
  updated_at: "2026-09-24T10:00:00.000Z",
});

const fallback = sessionAgentSnapshot({
  activeTool: undefined,
  hasMessages: false,
  isActive: false,
});

describe("sessionPanelSnapshot", () => {
  it("draws the main agent when there is no workflow", () => {
    expect(sessionPanelSnapshot({ fallback, live: undefined, mostRecentRun: undefined })).toBe(
      fallback,
    );
  });

  it("prefers the persisted run when it has seen more agents of the same run", () => {
    const persisted = snapshot("r1", 3);
    const result = sessionPanelSnapshot({
      fallback,
      live: snapshot("r1", 2),
      mostRecentRun: run("r1", persisted),
    });
    expect(result).toBe(persisted);
  });

  it("keeps the live snapshot when it is ahead of the persisted one", () => {
    const live = snapshot("r1", 4);
    expect(
      sessionPanelSnapshot({ fallback, live, mostRecentRun: run("r1", snapshot("r1", 2)) }),
    ).toBe(live);
  });

  it("keeps the live snapshot when the persisted run is a different one", () => {
    const live = snapshot("r2", 1);
    expect(
      sessionPanelSnapshot({ fallback, live, mostRecentRun: run("r1", snapshot("r1", 5)) }),
    ).toBe(live);
  });

  it("shows a placeholder for a run whose snapshot is not written yet", () => {
    const result = sessionPanelSnapshot({
      fallback,
      live: undefined,
      mostRecentRun: run("r1", null, "running"),
    });
    expect(result).toMatchObject({ name: "Workflow (running)", runId: "r1", runningCount: 1 });
  });
});

describe("persistedRunSnapshot", () => {
  it("counts a finished placeholder run as not running", () => {
    expect(persistedRunSnapshot(run("r1", null, "completed")).runningCount).toBe(0);
  });
});

describe("sessionAgentSnapshot", () => {
  it("names the tool the main agent is running", () => {
    const result = sessionAgentSnapshot({ activeTool: "bash", hasMessages: true, isActive: true });
    expect(result.agents[0]).toMatchObject({ label: "bash…", status: "running" });
  });

  it("is done once the session has spoken and stopped", () => {
    const result = sessionAgentSnapshot({ activeTool: undefined, hasMessages: true, isActive: false });
    expect(result).toMatchObject({ doneCount: 1, runningCount: 0 });
  });
});
