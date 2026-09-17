import { describe, expect, it } from "vitest";

import {
  agentSliceStatusLabel,
  deriveWholeRunSegment,
  deriveWorkflowPhaseProgress,
  phaseStatusLabel,
  type WorkflowPhaseAgentSlice,
} from "@/lib/workflow-phase-progress";
import type { WorkflowAgentSnapshot, WorkflowSnapshot } from "@/types/workflow";

function agent(
  overrides: Partial<WorkflowAgentSnapshot> & { id: number },
): WorkflowAgentSnapshot {
  return { label: `agent-${overrides.id}`, status: "running", ...overrides };
}

/**
 * The slice the `agent` builder above is expected to derive into. Mirrors its
 * defaults (label `agent-N`, status `running`) so a shape assertion does not
 * restate them.
 */
function slice(
  id: number,
  overrides: Partial<WorkflowPhaseAgentSlice> = {},
): WorkflowPhaseAgentSlice {
  return {
    cost: undefined,
    id,
    label: `agent-${id}`,
    model: undefined,
    status: "running",
    tokens: undefined,
    ...overrides,
  };
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
      { agentCount: 1, agents: [slice(1)], status: "done", title: "collect" },
      {
        agentCount: 2,
        agents: [slice(2), slice(3)],
        status: "running",
        title: "analyze",
      },
      { agentCount: 0, agents: [], status: "planned", title: "report" },
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
      { agentCount: 0, agents: [], status: "done", title: "collect" },
      { agentCount: 0, agents: [], status: "running", title: "surprise" },
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
      agents: [],
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
    expect(result?.[1]).toEqual({
      agentCount: 1,
      agents: [slice(1, { status: "error" })],
      status: "done",
      title: "analyze",
    });
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

    expect(result?.[0]).toEqual({
      agentCount: 1,
      agents: [slice(1, { status: "done" })],
      status: "done",
      title: "collect",
    });
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

describe("deriveWorkflowPhaseProgress agent slices", () => {
  it("exposes each phase's agents as slices in creation order, not snapshot order", () => {
    // `snapshot.agents` arrives merged from a live manager and a persisted run
    // file, so only `id` is a stable creation ordinal — hence the out-of-order
    // input here.
    const result = deriveWorkflowPhaseProgress(
      snapshot({
        agents: [
          agent({ id: 3, phase: "analyze", status: "queued" }),
          agent({ id: 1, phase: "analyze", status: "done" }),
          agent({ id: 2, phase: "analyze", status: "running" }),
        ],
        currentPhase: "analyze",
        phases: ["collect", "analyze"],
        runningCount: 1,
      }),
    );

    expect(result?.[1].agents.map((s) => s.id)).toEqual([1, 2, 3]);
    expect(result?.[1].agents.map((s) => s.status)).toEqual([
      "done",
      "running",
      "planned",
    ]);
  });

  it("keeps error and skipped distinct on a slice, though its phase collapses both to done", () => {
    // This is most of the point of drawing agents: the phase bar cannot say
    // which of its agents failed, and the snapshot does know.
    const result = deriveWorkflowPhaseProgress(
      snapshot({
        agents: [
          agent({ id: 1, phase: "work", status: "error" }),
          agent({ id: 2, phase: "work", status: "skipped" }),
          agent({ id: 3, phase: "work", status: "done" }),
        ],
        currentPhase: "work",
        phases: ["work", "report"],
        runStatus: "failed",
      }),
    );

    expect(result?.[0].status).toBe("done");
    expect(result?.[0].agents.map((s) => s.status)).toEqual([
      "error",
      "skipped",
      "done",
    ]);
  });

  it("carries model, tokens and cost through for the slice tooltip", () => {
    const result = deriveWorkflowPhaseProgress(
      snapshot({
        agents: [
          agent({
            cost: 0.42,
            id: 1,
            model: "openrouter/anthropic/claude-opus-5",
            phase: "work",
            status: "done",
            tokens: 12_600,
          }),
        ],
        currentPhase: "work",
        phases: ["work", "report"],
        runStatus: "completed",
      }),
    );

    expect(result?.[0].agents[0]).toEqual({
      cost: 0.42,
      id: 1,
      label: "agent-1",
      model: "openrouter/anthropic/claude-opus-5",
      status: "done",
      tokens: 12_600,
    });
  });

  it("gives a phase with no agents an empty slice list, not a placeholder slice", () => {
    // The component renders one solid phase-styled bar in this case; it must
    // be able to tell "no agents yet" from "one queued agent".
    const result = deriveWorkflowPhaseProgress(
      snapshot({
        agents: [agent({ id: 1, phase: "collect", status: "done" })],
        currentPhase: "collect",
        phases: ["collect", "analyze"],
        runningCount: 1,
      }),
    );

    expect(result?.[1].agents).toEqual([]);
    expect(result?.[1].agentCount).toBe(0);
  });

  it("keeps agentCount and agents.length in agreement", () => {
    const result = deriveWorkflowPhaseProgress(
      snapshot({
        agents: [
          agent({ id: 1, phase: "a" }),
          agent({ id: 2, phase: "b" }),
          agent({ id: 3, phase: "b" }),
          agent({ id: 4, phase: undefined }),
        ],
        currentPhase: "b",
        phases: ["a", "b"],
        runningCount: 1,
      }),
    );

    for (const segment of result ?? []) {
      expect(segment.agents).toHaveLength(segment.agentCount);
    }
  });

  it("ignores an agent whose phase matches no declared phase", () => {
    // An unphased agent (no `phase`) belongs to no segment and must not be
    // silently attributed to one.
    const result = deriveWorkflowPhaseProgress(
      snapshot({
        agents: [
          agent({ id: 1, phase: undefined }),
          agent({ id: 2, phase: "ghost" }),
          agent({ id: 3, phase: "a" }),
        ],
        currentPhase: "a",
        phases: ["a", "b"],
        runningCount: 1,
      }),
    );

    expect(result?.[0].agents.map((s) => s.id)).toEqual([3]);
    expect(result?.[1].agents).toEqual([]);
  });

  it("grows a sequential phase's slice list as agents are created (the lazy-creation case)", () => {
    // A three-agent sequential phase genuinely has 1, then 2, then 3 agents:
    // the runtime cannot know the eventual count, so the bar re-divides. This
    // pins that as intended behaviour rather than a regression.
    const phases = ["implement"];
    const at = (count: number) =>
      deriveWorkflowPhaseProgress(
        snapshot({
          agents: Array.from({ length: count }, (_, i) =>
            agent({ id: i + 1, phase: "implement" }),
          ),
          currentPhase: "implement",
          phases: [...phases, "validate"],
          runningCount: 1,
        }),
      )?.[0].agents.length;

    expect(at(1)).toBe(1);
    expect(at(2)).toBe(2);
    expect(at(3)).toBe(3);
  });
});

describe("deriveWholeRunSegment", () => {
  it("collapses a phaseless run into one segment carrying all its agents", () => {
    const result = deriveWholeRunSegment(
      snapshot({
        agents: [
          agent({ id: 2, status: "done" }),
          agent({ id: 1, status: "done" }),
        ],
        name: "flat run",
        phases: [],
        runStatus: "completed",
      }),
    );

    expect(result.status).toBe("done");
    expect(result.title).toBe("flat run");
    // Sorted by id (creation order), like the per-phase slices.
    expect(result.agents.map((s) => s.id)).toEqual([1, 2]);
    expect(result.agentCount).toBe(2);
  });

  it("includes agents regardless of their phase, since no phase splits them", () => {
    // A one-phase run's agents all carry that phase; a phaseless run's carry
    // none. Both must appear, so this must not filter on `phase` at all.
    const result = deriveWholeRunSegment(
      snapshot({
        agents: [
          agent({ id: 1, phase: "only", status: "done" }),
          agent({ id: 2, phase: undefined, status: "done" }),
        ],
        currentPhase: "only",
        phases: ["only"],
        runStatus: "completed",
      }),
    );

    expect(result.agents.map((s) => s.id)).toEqual([1, 2]);
  });

  it("prefers the single declared phase as its title, over the run name", () => {
    const result = deriveWholeRunSegment(
      snapshot({ name: "run name", phases: ["the phase"] }),
    );

    expect(result.title).toBe("the phase");
  });

  it("reports running only on direct evidence, never from absence of information", () => {
    // The same rule the phase derivation enforces: a run with nothing saying
    // it is live must not render as running.
    const silent = deriveWholeRunSegment(
      snapshot({ name: "silent", phases: [] }),
    );
    expect(silent.status).toBe("planned");

    const live = deriveWholeRunSegment(
      snapshot({
        agents: [agent({ id: 1, status: "running" })],
        name: "live",
        phases: [],
        runningCount: 1,
      }),
    );
    expect(live.status).toBe("running");
  });

  it("reports a terminal run done, whether it completed, failed or was aborted", () => {
    for (const runStatus of ["completed", "failed", "aborted"] as const) {
      const result = deriveWholeRunSegment(
        snapshot({
          agents: [agent({ id: 1, status: "error" })],
          name: runStatus,
          phases: [],
          runStatus,
        }),
      );
      expect(result.status).toBe("done");
    }
  });

  it("keeps a failed agent's own status distinct inside a done run", () => {
    const result = deriveWholeRunSegment(
      snapshot({
        agents: [
          agent({ id: 1, status: "error" }),
          agent({ id: 2, status: "skipped" }),
        ],
        name: "failed run",
        phases: [],
        runStatus: "failed",
      }),
    );

    expect(result.status).toBe("done");
    expect(result.agents.map((s) => s.status)).toEqual(["error", "skipped"]);
  });

  it("returns an empty agent list for a run with no agents, not a placeholder", () => {
    const result = deriveWholeRunSegment(
      snapshot({ name: "empty", phases: [] }),
    );

    expect(result.agents).toEqual([]);
    expect(result.agentCount).toBe(0);
  });
});

describe("agentSliceStatusLabel", () => {
  it("labels each slice status, distinguishing the two failure outcomes", () => {
    expect(agentSliceStatusLabel("done")).toBe("Done");
    expect(agentSliceStatusLabel("running")).toBe("In progress");
    expect(agentSliceStatusLabel("error")).toBe("Failed");
    expect(agentSliceStatusLabel("skipped")).toBe("Skipped");
  });

  it("calls a queued agent queued, where the phase bar would say planned", () => {
    // An agent that exists but has not started is queued; a phase with no
    // agents at all is merely planned. Same derived status, different words.
    expect(agentSliceStatusLabel("planned")).toBe("Queued");
    expect(phaseStatusLabel("planned")).toBe("Planned");
  });
});

describe("phaseStatusLabel", () => {
  it("labels each status for the tooltip", () => {
    expect(phaseStatusLabel("done")).toBe("Done");
    expect(phaseStatusLabel("running")).toBe("In progress");
    expect(phaseStatusLabel("planned")).toBe("Planned");
  });
});
