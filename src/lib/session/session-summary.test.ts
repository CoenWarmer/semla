import { describe, expect, it } from "vitest";

import {
  buildSessionSummary,
  mainAgentRow,
  summarizeWorkflow,
  summarizeWorkflows,
  summaryAgents,
} from "@/lib/session/session-summary";
import { NO_WIKI_ACTIVITY } from "@/lib/session/wiki-activity";
import type { WorkflowSnapshot } from "@/types/workflow";

const snapshot = (over: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot => ({
  agentCount: 0,
  agents: [],
  doneCount: 0,
  errorCount: 0,
  name: "run",
  phases: [],
  runningCount: 0,
  ...over,
});

describe("summarizeWorkflow", () => {
  it("keeps every agent's own model, cost and tokens", () => {
    const summary = summarizeWorkflow(
      snapshot({
        agents: [
          { cost: 0.5, id: 1, label: "researcher", model: "sonnet", phase: "Research", status: "done", tokens: 100 },
          { cost: 1.5, id: 2, label: "implementer", model: "opus", phase: "Build", status: "running", tokens: 300 },
        ],
        name: "session-summary",
        runId: "run-1",
      }),
    );

    // Per-agent, not one model for the run: a workflow's phases run on
    // different tiers by design.
    expect(summary?.agents).toEqual([
      { cost: 0.5, label: "researcher", model: "sonnet", phase: "Research", status: "done", tokens: 100 },
      { cost: 1.5, label: "implementer", model: "opus", phase: "Build", status: "running", tokens: 300 },
    ]);
    expect(summary?.name).toBe("session-summary");
  });

  it("sums its agents when the run reports no total of its own", () => {
    const summary = summarizeWorkflow(
      snapshot({
        agents: [
          { cost: 0.25, id: 1, label: "a", status: "done", tokens: 10 },
          { cost: 0.75, id: 2, label: "b", status: "done", tokens: 20 },
        ],
        runId: "run-1",
      }),
    );
    expect(summary?.usage).toEqual({ cost: 1, tokens: 30 });
  });

  it("prefers the run's own reported total over the agent sum", () => {
    // A completed background run's per-agent numbers can be sparser than its
    // total, so the run's figure is the better one.
    const summary = summarizeWorkflow(
      snapshot({
        agents: [{ cost: 0.1, id: 1, label: "a", status: "done", tokens: 10 }],
        runId: "run-1",
        tokenUsage: { cost: 2, total: 9052 },
      }),
    );
    expect(summary?.usage).toEqual({ cost: 2, tokens: 9052 });
  });

  it("omits an agent's model and phase rather than inventing them", () => {
    const summary = summarizeWorkflow(
      snapshot({ agents: [{ id: 1, label: "a", status: "queued" }], runId: "run-1" }),
    );
    expect(summary?.agents[0]).toEqual({ cost: 0, label: "a", status: "queued", tokens: 0 });
  });

  it("drops the synthetic snapshot that has no run id", () => {
    // That agent is the session's own and is already the main row.
    expect(summarizeWorkflow(snapshot({ agents: [{ id: 1, label: "a", status: "done" }] }))).toBeNull();
  });
});

describe("summarizeWorkflows", () => {
  it("dedupes by run id and prefers the live snapshot", () => {
    const runs = summarizeWorkflows({
      snapshot: snapshot({
        agents: [{ cost: 1, id: 1, label: "live", status: "running", tokens: 9052 }],
        runId: "run-1",
      }),
      workflowRuns: [
        {
          snapshot: snapshot({
            agents: [{ cost: 0.5, id: 1, label: "polled", status: "running", tokens: 5361 }],
            runId: "run-1",
          }),
        },
      ],
    });

    // The polled copy of a background run lags the live one — the same
    // preference countSessionAgents applies.
    expect(runs).toHaveLength(1);
    expect(runs[0].agents[0].label).toBe("live");
    expect(runs[0].usage.tokens).toBe(9052);
  });

  it("lists every distinct run", () => {
    const runs = summarizeWorkflows({
      workflowRuns: [
        { snapshot: snapshot({ name: "first", runId: "run-1" }) },
        { snapshot: snapshot({ name: "second", runId: "run-2" }) },
        { snapshot: null },
      ],
    });
    expect(runs.map((run) => run.name)).toEqual(["first", "second"]);
  });

  it("is empty for a session that has run no workflow", () => {
    expect(summarizeWorkflows({})).toEqual([]);
  });
});

describe("mainAgentRow", () => {
  it("reports the conversation's own share, not the session total", () => {
    // The workflows are listed separately; using the total here would count
    // them twice.
    const row = mainAgentRow({
      model: "opus",
      usage: { cost: 3, tokens: 1000 },
      workflows: [
        { agents: [], name: "w", runId: "r", usage: { cost: 2, tokens: 800 } },
      ],
    });
    expect(row).toEqual({
      cost: 1,
      label: "Session",
      model: "opus",
      status: "done",
      tokens: 200,
    });
  });

  it("never renders a negative cost when the two halves disagree", () => {
    // The conversation total and the run files come from different sources,
    // so a rounding disagreement must not surface as a negative.
    const row = mainAgentRow({
      model: null,
      usage: { cost: 1, tokens: 100 },
      workflows: [
        { agents: [], name: "w", runId: "r", usage: { cost: 5, tokens: 900 } },
      ],
    });
    expect(row.cost).toBe(0);
    expect(row.tokens).toBe(0);
  });

  it("omits the model for a session that has never been prompted", () => {
    const row = mainAgentRow({ model: null, usage: { cost: 0, tokens: 0 }, workflows: [] });
    expect(row.model).toBeUndefined();
  });
});

describe("buildSessionSummary", () => {
  const base = {
    artifacts: null,
    goal: "Ship the card",
    model: "opus",
    projects: ["semla"],
    title: "Session summary",
    usage: { cost: 2, tokens: 500 },
    wiki: NO_WIKI_ACTIVITY,
  };

  it("carries the header fields through unchanged", () => {
    const summary = buildSessionSummary(base);
    expect(summary.title).toBe("Session summary");
    expect(summary.goal).toBe("Ship the card");
    expect(summary.projects).toEqual(["semla"]);
    expect(summary.model).toBe("opus");
    expect(summary.usage).toEqual({ cost: 2, tokens: 500 });
  });

  it("copies projects rather than aliasing the caller's array", () => {
    const projects = ["semla"];
    const summary = buildSessionSummary({ ...base, projects });
    projects.push("other");
    expect(summary.projects).toEqual(["semla"]);
  });

  it("includes the session's workflows", () => {
    const summary = buildSessionSummary({
      ...base,
      workflowRuns: [{ snapshot: snapshot({ name: "audit", runId: "run-1" }) }],
    });
    expect(summary.workflows.map((run) => run.name)).toEqual(["audit"]);
  });
});

describe("summaryAgents", () => {
  it("lists the session's own agent first, then each run's", () => {
    const summary = buildSessionSummary({
      artifacts: null,
      goal: null,
      model: "opus",
      projects: [],
      title: null,
      usage: { cost: 3, tokens: 1000 },
      wiki: NO_WIKI_ACTIVITY,
      workflowRuns: [
        {
          snapshot: snapshot({
            agents: [
              { cost: 1, id: 1, label: "researcher", model: "sonnet", status: "done", tokens: 400 },
              { cost: 1, id: 2, label: "builder", model: "haiku", status: "done", tokens: 400 },
            ],
            runId: "run-1",
          }),
        },
      ],
    });

    expect(summaryAgents(summary).map((agent) => agent.label)).toEqual([
      "Session",
      "researcher",
      "builder",
    ]);
  });

  it("is just the session's own agent when no workflow ran", () => {
    const summary = buildSessionSummary({
      artifacts: null,
      goal: null,
      model: "opus",
      projects: [],
      title: null,
      usage: { cost: 1, tokens: 10 },
      wiki: NO_WIKI_ACTIVITY,
    });
    expect(summaryAgents(summary)).toEqual([
      { cost: 1, label: "Session", model: "opus", status: "done", tokens: 10 },
    ]);
  });
});
