import { describe, expect, it } from "vitest";

import { deriveWorkflowRunRows } from "@/lib/workflow-run-rows";
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

/** A completed multi-phase run, the ordinary case. */
function completedRun(runId: string, name: string): WorkflowSnapshot {
  return snapshot({
    agents: [
      agent({ id: 1, phase: "collect", status: "done" }),
      agent({ id: 2, phase: "report", status: "done" }),
    ],
    currentPhase: "report",
    name,
    phases: ["collect", "report"],
    runId,
    runStatus: "completed",
  });
}

describe("deriveWorkflowRunRows", () => {
  it("reverses the API's newest-first list so the oldest run is the top row", () => {
    // listWorkflowRuns returns newest-first; the bar sits under a transcript
    // that reads top-to-bottom, so the stack is chronological downward.
    const rows = deriveWorkflowRunRows([
      completedRun("run-new", "newest"),
      completedRun("run-mid", "middle"),
      completedRun("run-old", "oldest"),
    ]);

    expect(rows.map((row) => row.name)).toEqual(["oldest", "middle", "newest"]);
  });

  it("returns no rows for a session that has run no workflows", () => {
    expect(deriveWorkflowRunRows([])).toEqual([]);
    expect(deriveWorkflowRunRows(null)).toEqual([]);
    expect(deriveWorkflowRunRows(undefined)).toEqual([]);
  });

  it("drops a run whose snapshot is null rather than inventing an empty row", () => {
    // WorkflowRun.snapshot is null when a run has neither a file on disk nor a
    // stored snapshot. There is nothing to draw, and a placeholder row would
    // assert a shape never observed.
    const rows = deriveWorkflowRunRows([
      completedRun("run-b", "has snapshot"),
      null,
      undefined,
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("has snapshot");
  });

  it("keeps phase segments for a multi-phase run and does not mark it whole-run", () => {
    const rows = deriveWorkflowRunRows([completedRun("run-a", "phased")]);

    expect(rows[0].wholeRun).toBe(false);
    expect(rows[0].segments.map((s) => s.title)).toEqual(["collect", "report"]);
  });

  it("gives a phaseless run one whole-run segment instead of skipping it", () => {
    // deriveWorkflowPhaseProgress returns null for 0 or 1 phases. Skipping the
    // run would make the stack an incomplete list of the session's runs.
    const rows = deriveWorkflowRunRows([
      snapshot({
        agents: [agent({ id: 1, status: "done" })],
        name: "no phases",
        phases: [],
        runId: "run-flat",
        runStatus: "completed",
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].wholeRun).toBe(true);
    expect(rows[0].segments).toHaveLength(1);
    expect(rows[0].segments[0].status).toBe("done");
    expect(rows[0].segments[0].agents.map((s) => s.id)).toEqual([1]);
  });

  it("titles a single-phase run's whole-run segment with that phase, not the run name", () => {
    const rows = deriveWorkflowRunRows([
      snapshot({
        currentPhase: "only",
        name: "run name",
        phases: ["only"],
        runId: "run-one",
        runStatus: "completed",
      }),
    ]);

    expect(rows[0].wholeRun).toBe(true);
    expect(rows[0].segments[0].title).toBe("only");
    expect(rows[0].name).toBe("run name");
  });

  it("falls back to the run name when a phaseless run has no phase to borrow", () => {
    const rows = deriveWorkflowRunRows([
      snapshot({ name: "bare run", phases: [], runId: "run-bare" }),
    ]);

    expect(rows[0].segments[0].title).toBe("bare run");
  });

  it("replaces the listed entry for the live run instead of rendering it twice", () => {
    // The SSE snapshot is fresher than the API poll but describes a run the
    // list already contains; appending would duplicate the row.
    const live = snapshot({
      agents: [
        agent({ id: 1, phase: "collect", status: "done" }),
        agent({ id: 2, phase: "report", status: "running" }),
      ],
      currentPhase: "report",
      name: "live run",
      phases: ["collect", "report"],
      runId: "run-live",
      runningCount: 1,
    });

    const rows = deriveWorkflowRunRows(
      [
        snapshot({
          agents: [agent({ id: 1, phase: "collect", status: "done" })],
          currentPhase: "collect",
          name: "live run",
          phases: ["collect", "report"],
          runId: "run-live",
        }),
        completedRun("run-old", "older"),
      ],
      live,
    );

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.runId)).toEqual(["run-old", "run-live"]);
    // The live snapshot won: it is the one with two agents and a running phase.
    expect(rows[1].segments[1].status).toBe("running");
    expect(rows[1].segments[1].agents).toHaveLength(1);
  });

  it("appends a live run the list has not caught up with as the newest row", () => {
    // A background run's DB entry lags the workflow-started event, so for the
    // first seconds the live snapshot is the only record of it.
    const rows = deriveWorkflowRunRows(
      [completedRun("run-old", "older")],
      snapshot({
        agents: [agent({ id: 1, phase: "collect", status: "running" })],
        currentPhase: "collect",
        name: "brand new",
        phases: ["collect", "report"],
        runId: "run-brand-new",
        runningCount: 1,
      }),
    );

    expect(rows.map((row) => row.name)).toEqual(["older", "brand new"]);
  });

  it("renders a live run alone when the session's list is still empty", () => {
    const rows = deriveWorkflowRunRows(
      [],
      snapshot({
        currentPhase: "collect",
        name: "first run",
        phases: ["collect", "report"],
        runId: "run-first",
        runningCount: 1,
      }),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("first run");
  });

  it("does not merge a live snapshot that carries no runId", () => {
    // Identity is by runId only. A snapshot without one cannot be matched to a
    // listed run, so it is treated as its own newest entry rather than
    // silently replacing whichever run happens to be first.
    const rows = deriveWorkflowRunRows(
      [completedRun("run-old", "older")],
      snapshot({
        currentPhase: "collect",
        name: "unidentified",
        phases: ["collect", "report"],
        runningCount: 1,
      }),
    );

    expect(rows.map((row) => row.name)).toEqual(["older", "unidentified"]);
  });

  it("keys rows by runId, falling back to position when a snapshot has none", () => {
    const rows = deriveWorkflowRunRows([
      completedRun("run-keyed", "keyed"),
      snapshot({ name: "unkeyed", phases: [] }),
    ]);

    // Reversed, so the unkeyed (older) run is first at index 0.
    expect(rows[0].key).toBe("run-0");
    expect(rows[1].key).toBe("run-keyed");
  });

  it("gives every row a distinct key so React can tell the rows apart", () => {
    const rows = deriveWorkflowRunRows([
      completedRun("a", "a"),
      completedRun("b", "b"),
      snapshot({ name: "no id", phases: [] }),
    ]);

    const keys = rows.map((row) => row.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("reports the run's own tokenUsage as the row's usage", () => {
    const rows = deriveWorkflowRunRows([
      snapshot({
        name: "costed",
        phases: [],
        runId: "run-cost",
        runStatus: "completed",
        tokenUsage: { cost: 13.3077053, total: 36_475_349 },
      }),
    ]);

    expect(rows[0].usage).toEqual({
      cost: 13.3077053,
      partial: false,
      tokens: 36_475_349,
    });
  });

  it("marks a still-running run's total partial, and a finished one's final", () => {
    const usageFor = (runStatus: WorkflowSnapshot["runStatus"]) =>
      deriveWorkflowRunRows([
        snapshot({
          name: "run",
          phases: [],
          runStatus,
          tokenUsage: { cost: 1, total: 100 },
        }),
      ])[0].usage;

    expect(usageFor("running")?.partial).toBe(true);
    expect(usageFor("paused")?.partial).toBe(true);
    expect(usageFor("pending")?.partial).toBe(true);
    // Absence of a lifecycle status means unknown, and a running total is the
    // honest read of an unknown one.
    expect(usageFor(undefined)?.partial).toBe(true);

    expect(usageFor("completed")?.partial).toBe(false);
    expect(usageFor("failed")?.partial).toBe(false);
    expect(usageFor("aborted")?.partial).toBe(false);
  });

  it("falls back to summing its agents when the run reports no tokenUsage", () => {
    // Verified equivalent on a real run: the agents summed to the run's own
    // tokenUsage.total exactly. This is a second route to one number.
    const rows = deriveWorkflowRunRows([
      snapshot({
        agents: [
          agent({ cost: 0.62, id: 1, status: "done", tokens: 1_560_335 }),
          agent({ cost: 0.18, id: 2, status: "done", tokens: 223_016 }),
        ],
        name: "summed",
        phases: [],
        runStatus: "completed",
      }),
    ]);

    expect(rows[0].usage?.tokens).toBe(1_783_351);
    expect(rows[0].usage?.cost).toBeCloseTo(0.8, 10);
    expect(rows[0].usage?.partial).toBe(false);
  });

  it("prefers the run's own tokenUsage over the agent sum, for retried spend", () => {
    // A retried attempt's spend accrues to the run but leaves no surviving
    // agent record (see onRetrySpend), so summing agents under-counts it.
    const rows = deriveWorkflowRunRows([
      snapshot({
        agents: [agent({ cost: 1, id: 1, status: "done", tokens: 100 })],
        name: "retried",
        phases: [],
        runStatus: "completed",
        tokenUsage: { cost: 3, total: 300 },
      }),
    ]);

    expect(rows[0].usage).toEqual({ cost: 3, partial: false, tokens: 300 });
  });

  it("omits usage entirely when nothing has reported any", () => {
    // Distinct from zero: a run that has reported nothing is not a run that
    // cost nothing, and the tooltip says so differently.
    const rows = deriveWorkflowRunRows([
      snapshot({ name: "silent", phases: [], runId: "run-silent" }),
    ]);

    expect(rows[0].usage).toBeUndefined();
  });

  it("treats a run whose agents report only tokens, with no cost, as usage", () => {
    // A provider that reports no cost still gives a token count; dropping the
    // row's usage because cost is 0 would hide it.
    const rows = deriveWorkflowRunRows([
      snapshot({
        agents: [agent({ id: 1, status: "done", tokens: 5_000 })],
        name: "tokens only",
        phases: [],
        runStatus: "completed",
      }),
    ]);

    expect(rows[0].usage).toEqual({ cost: 0, partial: false, tokens: 5_000 });
  });

  it("takes usage from the live snapshot for the run it replaces", () => {
    const rows = deriveWorkflowRunRows(
      [
        snapshot({
          name: "live run",
          phases: [],
          runId: "run-live",
          tokenUsage: { cost: 1, total: 100 },
        }),
      ],
      snapshot({
        name: "live run",
        phases: [],
        runId: "run-live",
        runningCount: 1,
        tokenUsage: { cost: 2.5, total: 250 },
      }),
    );

    expect(rows[0].usage).toEqual({ cost: 2.5, partial: true, tokens: 250 });
  });

  it("preserves per-agent tokens and cost through to the slices", () => {
    const rows = deriveWorkflowRunRows([
      snapshot({
        agents: [
          agent({
            cost: 1.5,
            id: 1,
            phase: "collect",
            status: "done",
            tokens: 24_000_000,
          }),
        ],
        currentPhase: "collect",
        name: "with usage",
        phases: ["collect", "report"],
        runId: "run-usage",
        runStatus: "completed",
      }),
    ]);

    expect(rows[0].segments[0].agents[0]).toMatchObject({
      cost: 1.5,
      tokens: 24_000_000,
    });
  });
});
