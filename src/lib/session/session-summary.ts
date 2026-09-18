/**
 * Everything the session summary card shows, assembled in one place.
 *
 * The card answers "what did this session do" — title, goal, projects, what it
 * cost, which models did the work, and what went in and came out. Every field
 * already existed somewhere; this module is the join, not a new source of
 * truth, and it deliberately reuses the existing ones rather than recomputing:
 *
 *  - cost/tokens: the caller passes `useSessionCost`'s total, which is
 *    `addUsage(runs, conversation)` — see session-usage.ts for why summing is
 *    the only correct rule and why the two halves cannot double count.
 *  - artifacts: `ArtifactSummary` as-is, from the status route.
 *  - wiki: `deriveWikiActivity` over the transcript the page already holds.
 *
 * Client-safe and pure, same reason artifact-summary.ts is: the session page
 * is a client component with the transcript, the workflow runs and the status
 * poll all already in hand, so the summary costs a render rather than a route.
 */

import type { ArtifactSummary } from "@/lib/artifacts/artifact-summary";
import type { SessionUsage } from "@/lib/session/session-usage";
import type { WikiActivity } from "@/lib/session/wiki-activity";
import type { WorkflowAgentSnapshot, WorkflowSnapshot } from "@/types/workflow";

/**
 * One agent's own contribution.
 *
 * Per-agent rather than one model per session, because a multi-agent session
 * genuinely has no single answer: a workflow's phases run on different tiers
 * by design, so "the model used" would have to pick one and be wrong about
 * the rest.
 */
export interface SummaryAgent {
  label: string;
  /** Undefined for an agent whose run recorded no model. */
  model?: string;
  cost: number;
  tokens: number;
  /** Which phase it ran in, when the run declared phases. */
  phase?: string;
  status: WorkflowAgentSnapshot["status"];
}

/** One workflow run, with the agents it ran. */
export interface SummaryWorkflow {
  runId: string;
  name: string;
  agents: SummaryAgent[];
  /** Summed over this run's agents. */
  usage: SessionUsage;
}

export interface SessionSummary {
  title: string | null;
  goal: string | null;
  /** Workspace-relative paths, anchor first (the status route's order). */
  projects: string[];
  /** Conversation + every workflow run. */
  usage: SessionUsage;
  /** The model the main conversation ran on. */
  model: string | null;
  workflows: SummaryWorkflow[];
  artifacts: ArtifactSummary | null;
  wiki: WikiActivity;
}

/**
 * The main agent counts too.
 *
 * `countSessionAgents` already encodes this for its running/idle tally — "the
 * thing answering prompts is an agent too" — and the card's agent list would
 * otherwise omit the one agent every session has.
 */
export function mainAgentRow({
  model,
  usage,
  workflows,
}: {
  model: string | null;
  usage: SessionUsage;
  workflows: readonly SummaryWorkflow[];
}): SummaryAgent {
  // The conversation's own share, not the session total: the workflows are
  // listed separately, and showing the total here would count them twice.
  const workflowCost = workflows.reduce((sum, run) => sum + run.usage.cost, 0);
  const workflowTokens = workflows.reduce((sum, run) => sum + run.usage.tokens, 0);

  return {
    // Clamped at zero: the two halves come from different sources (a stamped
    // conversation total and the run files), and a rounding disagreement must
    // not render as a negative cost.
    cost: Math.max(0, usage.cost - workflowCost),
    label: "Session",
    ...(model ? { model } : {}),
    status: "done",
    tokens: Math.max(0, usage.tokens - workflowTokens),
  };
}

/** One run's agents and its summed usage. */
export function summarizeWorkflow(snapshot: WorkflowSnapshot): SummaryWorkflow | null {
  // A snapshot with no run id is the synthetic single-agent one built for a
  // workflow-less session (see session-agent-counts.ts) — that agent is the
  // session's own and is already the main row.
  if (!snapshot.runId) return null;

  const agents: SummaryAgent[] = snapshot.agents.map((agent) => ({
    cost: agent.cost ?? 0,
    label: agent.label,
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.phase ? { phase: agent.phase } : {}),
    status: agent.status,
    tokens: agent.tokens ?? 0,
  }));

  return {
    agents,
    name: snapshot.name,
    runId: snapshot.runId,
    // The run's own reported total when it has one, else the sum of its
    // agents. Preferring the run's figure matters for a completed background
    // run, whose per-agent numbers can be sparser than its total.
    usage: {
      cost: snapshot.tokenUsage?.cost ?? agents.reduce((sum, a) => sum + a.cost, 0),
      tokens: snapshot.tokenUsage?.total ?? agents.reduce((sum, a) => sum + a.tokens, 0),
    },
  };
}

/**
 * Every run this session has, one row per run id, preferring the live one.
 *
 * The same dedupe `countSessionAgents` does, and for the same reason: a run
 * that has just started is not in the polled list yet, and the polled copy of
 * a background run can lag the live one.
 */
export function summarizeWorkflows({
  snapshot,
  workflowRuns,
}: {
  snapshot?: WorkflowSnapshot;
  workflowRuns?: readonly { snapshot: WorkflowSnapshot | null }[];
}): SummaryWorkflow[] {
  const byRun = new Map<string, WorkflowSnapshot>();

  for (const run of workflowRuns ?? []) {
    if (run.snapshot?.runId) byRun.set(run.snapshot.runId, run.snapshot);
  }
  // Last, so the live snapshot wins over the polled copy of the same run.
  if (snapshot?.runId) byRun.set(snapshot.runId, snapshot);

  const summaries: SummaryWorkflow[] = [];
  for (const run of byRun.values()) {
    const summary = summarizeWorkflow(run);
    if (summary) summaries.push(summary);
  }

  return summaries;
}

/** The card's whole input, from what the session page already holds. */
export function buildSessionSummary({
  artifacts,
  goal,
  model,
  projects,
  snapshot,
  title,
  usage,
  wiki,
  workflowRuns,
}: {
  artifacts: ArtifactSummary | null;
  goal: string | null;
  model: string | null;
  projects: readonly string[];
  snapshot?: WorkflowSnapshot;
  title: string | null;
  usage: SessionUsage;
  wiki: WikiActivity;
  workflowRuns?: readonly { snapshot: WorkflowSnapshot | null }[];
}): SessionSummary {
  const workflows = summarizeWorkflows({ snapshot, workflowRuns });

  return {
    artifacts,
    goal,
    model,
    projects: [...projects],
    title,
    usage,
    wiki,
    workflows,
  };
}

/** Every agent the card lists: the session's own first, then each run's. */
export function summaryAgents(summary: SessionSummary): SummaryAgent[] {
  return [
    mainAgentRow({
      model: summary.model,
      usage: summary.usage,
      workflows: summary.workflows,
    }),
    ...summary.workflows.flatMap((run) => run.agents),
  ];
}
