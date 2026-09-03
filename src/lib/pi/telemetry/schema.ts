/**
 * The spans Semla owns, declared the way pi declares its own.
 *
 * pi's schema already names everything that happens inside an agent —
 * `pi.harness.run`, `pi.harness.turn`, `pi.harness.tool`, `pi.ai.request` and
 * the rest — so those names are used as they come. What it has no notion of is
 * a *workflow*: a run that fans out into phases, each spawning subagents that
 * are themselves agents. Those three concepts are ours, so these three spans
 * are too.
 *
 * Declared through `defineTelemetrySchema` rather than as loose strings for the
 * reason the plan gives: a second, untyped description of the same events is
 * how `workflow-spans.ts` came to be a drawing of what the UI happened to know
 * rather than a record of what ran. A declaration carries the attribute types,
 * which of them are required, and which are sensitive — and that last one is
 * what lets the sink redact without every call site knowing.
 *
 * See docs/plans/agent-telemetry.md §5 for the tree these form together with
 * pi's, and §8.4 for why a background workflow run nests under its turn.
 */

import { defineTelemetrySchema } from "@mariozechner/pi-agent-core";

/**
 * Pi's own run span, redeclared here because Semla puts one attribute of its
 * own on it.
 *
 * Not a second definition of pi's span — `HARNESS_TELEMETRY_SCHEMA` is still
 * the authority on `pi.harness.run` — but the place our additions to it are
 * declared. Declaring them matters for one concrete reason:
 * `sensitiveAttributeKeys` builds its key set by walking the schemas, so an
 * attribute that appears in none of them is one redaction can never find. A
 * prompt excerpt written straight onto the span with no declaration would sit
 * in every persisted trace with the `sensitive: "drop"` switch unable to
 * touch it.
 */
export const HARNESS_RUN_SPAN_NAME = "pi.harness.run";
export const HARNESS_STEP_SPAN_NAME = "pi.harness.step";

export const WORKFLOW_RUN_SPAN = "semla.workflow.run";
export const WORKFLOW_PHASE_SPAN = "semla.workflow.phase";
export const WORKFLOW_AGENT_SPAN = "semla.workflow.agent";

export const SEMLA_TELEMETRY_SCHEMA = defineTelemetrySchema({
  version: 1,
  spans: {
    [HARNESS_RUN_SPAN_NAME]: {
      description:
        "Semla's additions to pi's run span. One prompt is one run here, so " +
        "this is the row a reader identifies a prompt by.",
      parents: { kind: "any" },
      startAttributes: {
        "semla.prompt.excerpt": {
          description:
            "The beginning of the prompt that started this run, bounded — " +
            "the transcript holds the whole thing. Recorded so the row can be " +
            "labelled by what was asked; how much of it is shown is the " +
            "panel's decision, not this one's.",
          type: "string",
          required: false,
          // User text, so the same treatment as a subagent's prompt: kept
          // today per §8.1, and droppable by config rather than by edit.
          sensitive: true,
          cardinality: "high",
        },
      },
      // Empty rather than absent: pi's own declaration owns this span's end
      // attributes and status, and restating them here would be a second
      // source of truth for something we do not define.
      endAttributes: {},
      status: { default: "ok", errorWhen: "pi's own declaration decides" },
    },

    [HARNESS_STEP_SPAN_NAME]: {
      description:
        "Semla's additions to pi's step span: one model round trip inside a " +
        "turn, and what it cost.",
      parents: { kind: "any" },
      startAttributes: {},
      endAttributes: {
        "gen_ai.usage.total_tokens": {
          description:
            "Tokens this round trip consumed, as the assistant message " +
            "reported them.",
          type: "number",
        },
        "gen_ai.usage.cost": {
          description: "Cost in USD for this round trip.",
          type: "number",
        },
      },
      // pi's own declaration owns this span's status and start attributes.
      status: { default: "ok", errorWhen: "pi's own declaration decides" },
    },

    [WORKFLOW_RUN_SPAN]: {
      description:
        "One workflow run. Nests under the turn that started it, including " +
        "when it outlives that turn in the background.",
      // A run normally has a turn above it, but a background run recovered
      // after a restart has nothing — the turn that started it is gone.
      parents: { kind: "any" },
      startAttributes: {
        "semla.workflow.run_id": {
          description: "Run id, as used by the run file and the workflow panel.",
          type: "string",
          required: true,
          cardinality: "high",
        },
        "semla.workflow.name": {
          description: "Workflow name from the script's meta block.",
          type: "string",
          required: true,
          cardinality: "low",
        },
        "semla.workflow.background": {
          description: "Whether the run was started in the background.",
          type: "boolean",
          required: true,
        },
      },
      endAttributes: {
        "semla.workflow.agent_count": {
          description: "Agents the run ended with.",
          type: "number",
        },
        "semla.workflow.done_count": {
          description: "Agents that finished successfully.",
          type: "number",
        },
        "semla.workflow.error_count": {
          description: "Agents that failed.",
          type: "number",
        },
        "semla.workflow.status": {
          description:
            "How the run's span ended. \"paused\" is terminal for the span but " +
            "not for the run: a resume opens a new one under the same run id.",
          type: "string",
          values: ["completed", "failed", "aborted", "paused"],
          cardinality: "low",
        },
      },
      status: { default: "ok", errorWhen: "the run ended failed or aborted" },
    },

    [WORKFLOW_PHASE_SPAN]: {
      description:
        "A phase of a workflow: the agents between one phase() call and the " +
        "next. Groups agents rather than doing work itself.",
      parents: { kind: "spans", spans: [WORKFLOW_RUN_SPAN] },
      startAttributes: {
        "semla.workflow.phase.title": {
          description: "Phase title, matched to the script's meta.phases entry.",
          type: "string",
          required: true,
          cardinality: "low",
        },
        "semla.workflow.phase.index": {
          description: "Zero-based position in the run.",
          type: "number",
          required: true,
        },
      },
      endAttributes: {
        "semla.workflow.phase.agent_count": {
          description: "Agents that ran in this phase.",
          type: "number",
        },
      },
      status: { default: "ok", errorWhen: "any agent in the phase failed" },
    },

    [WORKFLOW_AGENT_SPAN]: {
      description:
        "One subagent call. Its own turns and tool calls nest under it as " +
        "pi.harness.* spans, so a subagent reads like a small session.",
      parents: {
        kind: "spans",
        // An agent normally sits in a phase, but a workflow that never calls
        // phase() puts its agents directly under the run.
        spans: [WORKFLOW_PHASE_SPAN, WORKFLOW_RUN_SPAN],
      },
      startAttributes: {
        "semla.workflow.agent.call_id": {
          description:
            "Unique per agent() call, not per label — concurrent agents " +
            "routinely share a label. The key everything per-agent hangs off.",
          type: "string",
          required: true,
          cardinality: "high",
        },
        "semla.workflow.agent.id": {
          description:
            "The agent's position in the run snapshot, which is what the " +
            "workflow panel and the waterfall identify it by.",
          type: "number",
          required: false,
        },
        "semla.workflow.agent.label": {
          description: "Human label from the agent() call.",
          type: "string",
          required: true,
          cardinality: "high",
        },
        "semla.workflow.agent.model": {
          description: "Resolved provider/model the subagent ran with.",
          type: "string",
          required: false,
          cardinality: "low",
        },
        "semla.workflow.agent.prompt": {
          description: "The prompt the subagent was given.",
          type: "string",
          required: false,
          // The one attribute here that can carry anything the caller put in
          // it. Marked so the sink can drop it without knowing what it is;
          // kept by default today, see the plan's §8.1.
          sensitive: true,
          cardinality: "high",
        },
      },
      endAttributes: {
        "semla.workflow.agent.status": {
          description: "How the agent call ended.",
          type: "string",
          values: ["done", "error", "aborted"],
          cardinality: "low",
        },
        "semla.workflow.agent.turns": {
          description: "Model round trips the subagent took.",
          type: "number",
        },
        "semla.workflow.agent.total_tokens": {
          description: "Tokens the subagent consumed, input and output.",
          type: "number",
        },
        "semla.workflow.agent.cost": {
          description: "Cost in USD, as reported by the provider.",
          type: "number",
        },
      },
      status: { default: "ok", errorWhen: "the agent call threw or was aborted" },
    },
  },
});
