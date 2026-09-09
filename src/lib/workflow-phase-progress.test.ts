import { describe, expect, it } from "vitest";

import {
  deriveWorkflowPhaseProgress,
  phaseStatusLabel,
} from "@/lib/workflow-phase-progress";
import type { WorkflowAgentSnapshot, WorkflowSnapshot } from "@/types/workflow";

function agent(
  overrides: Partial<WorkflowAgentSnapshot> & { id: number },
): WorkflowAgentSnapshot {
  return { label: `agent-${overrides.id}`, status: "running", ...overrides };
}

function snapshot(overrides: Partial<WorkflowSnapshot>): WorkflowSnapshot {
  return {
    agentCount: 0,
    agents: [],
    doneCount: 0,
    errorCount: 0,
    name: "Test workflow",
    phases: [],
    runningCount: 0,
    ...overrides,
  };
}

describe("deriveWorkflowPhaseProgress", () => {
  it("derives done / running / planned from position relative to currentPhase in a normal 3-phase run", () => {
    const result = deriveWorkflowPhaseProgress(
      snapshot({
        agents: [
          agent({ id: 1, phase: "collect" }),
          agent({ id: 2, phase: "analyze" }),
          agent({ id: 3, phase: "analyze" }),
        ],
        currentPhase: "analyze",
        phases: ["collect", "analyze", "report"],
      }),
    );

    expect(result).toEqual([
      { agentCount: 1, status: "done", title: "collect" },
      { agentCount: 2, status: "running", title: "analyze" },
      { agentCount: 0, status: "planned", title: "report" },
    ]);
  });

  it("treats a skipped declared phase as done once the run has moved past it", () => {
    // "review" was declared but a branching script skipped straight to
    // "report" — there is no way to tell "skipped" from "ran" here, and the
    // derivation does not pretend otherwise: it is simply behind currentPhase.
    // `runningCount: 1` is the live-evidence signal that this is an
    // in-progress run (not a finished one whose currentPhase just lingers) —
    // see the "unknown/absent lifecycle" test for the case with none.
    const result = deriveWorkflowPhaseProgress(
      snapshot({
        currentPhase: "report",
        phases: ["collect", "review", "report"],
        runningCount: 1,
      }),
    );

    expect(result?.map((s) => s.status)).toEqual(["done", "done", "running"]);
  });

  it("handles a phase reached that was never declared up front", () => {
    // The runtime appends newly-reached undeclared phases to `phases` in
    // first-reach order, so by the time the snapshot is read it is already
    // one more ordered entry — the derivation does not need special-casing.
    // `runningCount: 1` supplies the live-evidence this run is actually
    // in progress (see the "unknown/absent lifecycle" test for the case
    // with none, which is the bug this module now guards against).
    const result = deriveWorkflowPhaseProgress(
      snapshot({
        currentPhase: "surprise",
        phases: ["collect", "surprise"],
        runningCount: 1,
      }),
    );

    expect(result).toEqual([
      { agentCount: 0, status: "done", title: "collect" },
      { agentCount: 0, status: "running", title: "surprise" },
    ]);
  });

  it("reports zero agents for a phase with none, without treating it as an error", () => {
    const result = deriveWorkflowPhaseProgress(
      snapshot({
        agents: [agent({ id: 1, phase: "collect" })],
        currentPhase: "collect",
        phases: ["collect", "analyze"],
      }),
    );

    expect(result?.[1]).toEqual({
      agentCount: 0,
      status: "planned",
      title: "analyze",
    });
  });

  it("signals render-nothing for a single-phase run", () => {
    const result = deriveWorkflowPhaseProgress(
      snapshot({ currentPhase: "only", phases: ["only"] }),
    );

    expect(result).toBeNull();
  });

  it("signals render-nothing when there are no declared phases at all", () => {
    const result = deriveWorkflowPhaseProgress(snapshot({ phases: [] }));

    expect(result).toBeNull();
  });

  it("signals render-nothing for an empty or undefined snapshot", () => {
    expect(deriveWorkflowPhaseProgress(undefined)).toBeNull();
    expect(deriveWorkflowPhaseProgress(null)).toBeNull();
  });

  it("falls back to all-planned if currentPhase does not match any declared phase", () => {
    // Defensive: should not happen, but must not hang or throw either.
    const result = deriveWorkflowPhaseProgress(
      snapshot({
        currentPhase: "nowhere",
        phases: ["collect", "analyze"],
      }),
    );

    expect(result?.map((s) => s.status)).toEqual(["planned", "planned"]);
  });

  it("never marks a phase running when the run's lifecycle state is unknown/absent (the user's reported bug)", () => {
    // No runStatus, no agents, no runningCount — just a currentPhase left
    // over with nothing at all saying the run is still going.
    const result = deriveWorkflowPhaseProgress(
      snapshot({
        currentPhase: "report",
        phases: ["collect", "analyze", "report"],
      }),
    );

    expect(result?.map((s) => s.status)).not.toContain("running");
    expect(result?.map((s) => s.status)).toEqual(["done", "done", "planned"]);
  });

  it("marks a completed run's reached phases done, not running, via explicit runStatus", () => {
    const result = deriveWorkflowPhaseProgress(
      snapshot({
        agents: [
          agent({ id: 1, phase: "collect", status: "done" }),
          agent({ id: 2, phase: "analyze", status: "done" }),
        ],
        currentPhase: "analyze",
        phases: ["collect", "analyze", "report"],
        runStatus: "completed",
      }),
    );

    expect(result?.map((s) => s.status)).not.toContain("running");
    expect(result?.map((s) => s.status)).toEqual(["done", "done", "planned"]);
  });

  it("marks a failed (errored) run's reached phase done, not running", () => {
    const result = deriveWorkflowPhaseProgress(
      snapshot({
        agents: [agent({ id: 1, phase: "analyze", status: "error" })],
        currentPhase: "analyze",
        phases: ["collect", "analyze", "report"],
        runStatus: "failed",
      }),
    );

    expect(result?.map((s) => s.status)).not.toContain("running");
    expect(result?.[1]).toEqual({ agentCount: 1, status: "done", title: "analyze" });
  });

  it("marks an aborted run's reached phase done, not running", () => {
    const result = deriveWorkflowPhaseProgress(
      snapshot({
        agents: [agent({ id: 1, phase: "analyze", status: "skipped" })],
        currentPhase: "analyze",
        phases: ["collect", "analyze", "report"],
        runStatus: "aborted",
      }),
    );

    expect(result?.map((s) => s.status)).not.toContain("running");
  });

  it("a declared phase never reached in a terminal run is not done", () => {
    // "review" was declared but the run finished at "collect" without ever
    // reaching it (e.g. failed early) — it must render neither running nor
    // done, since it was never entered.
    const result = deriveWorkflowPhaseProgress(
      snapshot({
        agents: [agent({ id: 1, phase: "collect", status: "done" })],
        currentPhase: "collect",
        phases: ["collect", "review", "report"],
        runStatus: "completed",
      }),
    );

    expect(result?.[0]).toEqual({ agentCount: 1, status: "done", title: "collect" });
    expect(result?.[1].status).not.toBe("done");
    expect(result?.[1].status).not.toBe("running");
    expect(result?.[2].status).not.toBe("done");
    expect(result?.[2].status).not.toBe("running");
  });

  it("keeps the live-run behavior intact: currentPhase running when runningCount > 0", () => {
    const result = deriveWorkflowPhaseProgress(
      snapshot({
        agents: [agent({ id: 1, phase: "analyze", status: "running" })],
        currentPhase: "analyze",
        phases: ["collect", "analyze", "report"],
        runningCount: 1,
      }),
    );

    expect(result?.map((s) => s.status)).toEqual(["done", "running", "planned"]);
  });

  it("keeps the live-run behavior intact when runStatus explicitly says running", () => {
    const result = deriveWorkflowPhaseProgress(
      snapshot({
        agents: [agent({ id: 1, phase: "analyze", status: "running" })],
        currentPhase: "analyze",
        phases: ["collect", "analyze", "report"],
        runStatus: "running",
        runningCount: 1,
      }),
    );

    expect(result?.map((s) => s.status)).toEqual(["done", "running", "planned"]);
  });

  it("does not treat a zero-agent run as terminal by the agent-status fallback", () => {
    // No runStatus and no agents at all: must not be read as terminal, so a
    // currentPhase with no other evidence of running stays "planned" rather
    // than "done" — there is nothing here that says the run ever finished,
    // only that nothing has been observed yet.
    const result = deriveWorkflowPhaseProgress(
      snapshot({
        currentPhase: "collect",
        phases: ["collect", "analyze"],
      }),
    );

    expect(result?.[0].status).toBe("planned");
  });

  it("does not treat an all-queued run as terminal by the agent-status fallback", () => {
    const result = deriveWorkflowPhaseProgress(
      snapshot({
        agents: [
          agent({ id: 1, phase: "collect", status: "queued" }),
          agent({ id: 2, phase: "collect", status: "queued" }),
        ],
        currentPhase: "collect",
        phases: ["collect", "analyze"],
      }),
    );

    // Not terminal (all-queued), and not actively running either (no agent
    // is "running", runningCount is 0) — so the current phase is "planned",
    // never "done" (which would require terminality) and never "running".
    expect(result?.[0].status).toBe("planned");
  });
});

describe("phaseStatusLabel", () => {
  it("labels each status for the tooltip", () => {
    expect(phaseStatusLabel("done")).toBe("Done");
    expect(phaseStatusLabel("running")).toBe("In progress");
    expect(phaseStatusLabel("planned")).toBe("Planned");
  });
});
