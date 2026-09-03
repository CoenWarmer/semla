/**
 * Recorded spans, shaped for the waterfall.
 *
 * The counterpart to `workflow-spans.ts`, and the reason it now has one. That
 * module synthesises a tree from whatever the UI happens to be holding — a
 * snapshot, the message list, the tool calls — and infers timing from it: an
 * agent with no `startedAt` is anchored to `now`, a phase's bounds are the
 * min and max of its agents, and a prompt turn is drawn at its agent's start
 * because the history timestamps are all stamped at creation. Every one of
 * those is a guess that happens to look right.
 *
 * These spans were recorded as the work ran, so none of that applies: the
 * times are measured, the parents are the real ones, and a span that is still
 * open is genuinely still running. This module only translates.
 *
 * The two are never combined into one tree (plan §8.5). A row whose duration
 * was measured and a row whose duration was inferred look identical in a
 * waterfall, and a trace that mixes them is one you cannot trust a reading
 * from. The panel picks a source and says which it is showing.
 */

import type { OtelSpan } from "react-otel-trace-waterfall";
import { makeSpanId } from "react-otel-trace-waterfall";
import {
  HARNESS_RUN_SPAN,
  HARNESS_TOOL_SPAN,
  HARNESS_TURN_SPAN,
} from "@/lib/pi/telemetry/host-recorder";
import {
  WORKFLOW_AGENT_SPAN,
  WORKFLOW_PHASE_SPAN,
  WORKFLOW_RUN_SPAN,
} from "@/lib/pi/telemetry/schema";
import type { RecordedSpan } from "@/lib/pi/telemetry/span-sink";

/** The millisecond half of the union — what a recorded span maps onto. */
type MsSpan = Extract<OtelSpan, { startTimeMs: number }>;

/** What the waterfall accepts, which is narrower than what pi records. */
type WaterfallAttributes = NonNullable<MsSpan["attributes"]>;

/**
 * Attribute keys the panel's renderers read. They predate this module and are
 * spelled the way `workflow-spans.ts` spells them, so recorded spans carry
 * them too rather than the panel learning a second vocabulary: `pi.status`
 * drives the shimmer and the queued placeholder, `pi.agent_id` with
 * `pi.run_id` opens an agent's transcript, and `service.name` picks the bar
 * colour.
 */
const AGENT_ID = "pi.agent_id";
const RUN_ID = "pi.run_id";
const STATUS = "pi.status";

/**
 * pi's attribute values include arrays, which the waterfall's do not. Joined
 * rather than dropped: an array attribute is usually a list of model or tool
 * names, and seeing it matters more than its exact shape in a tooltip.
 */
const coerce = (
  attributes: RecordedSpan["attributes"],
): WaterfallAttributes => {
  const out: WaterfallAttributes = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined) continue;
    // Not `Array.isArray`: it narrows a `readonly T[]` to `any[]` and leaves
    // the readonly form in the false branch, so the join would type-check and
    // the passthrough would not.
    out[key] = typeof value === "object" ? value.join(", ") : value;
  }

  return out;
};

/** Which bar palette entry a span takes, by what kind of work it describes. */
const serviceOf = (name: string): string => {
  if (name === WORKFLOW_AGENT_SPAN) return "agent";
  if (name === WORKFLOW_RUN_SPAN || name === WORKFLOW_PHASE_SPAN) {
    return "workflow";
  }
  if (name === HARNESS_TOOL_SPAN) return "tool";
  if (name === HARNESS_TURN_SPAN || name === HARNESS_RUN_SPAN) return "session";
  if (name.startsWith("pi.ai.")) return "assistant";
  return "session";
};

/**
 * The row label. A span name is a schema identifier — every agent in a run is
 * `semla.workflow.agent` — so the label comes from the attribute that
 * distinguishes them, falling back to the name when it is absent, which is
 * only possible for a span the cap dropped attributes from.
 */
const labelOf = (span: RecordedSpan): string => {
  const named = (key: string) => {
    const value = span.attributes[key];
    return typeof value === "string" && value.length > 0 ? value : null;
  };

  if (span.name === WORKFLOW_RUN_SPAN) {
    return named("semla.workflow.name") ?? "Workflow";
  }
  if (span.name === WORKFLOW_PHASE_SPAN) {
    return named("semla.workflow.phase.title") ?? "Phase";
  }
  if (span.name === WORKFLOW_AGENT_SPAN) {
    return named("semla.workflow.agent.label") ?? "Agent";
  }
  // Host spans, whose names are pi's schema identifiers for the same reason
  // ours are: a row reading "pi.harness.tool" tells a reader nothing, and the
  // tool's name is an attribute. The glyph matches the derived timeline's, so
  // switching sources does not change what a tool row looks like.
  if (span.name === HARNESS_TOOL_SPAN) {
    const tool = named("pi.tool.name");
    return tool ? `⚙ ${tool}` : "⚙ tool";
  }
  if (span.name === HARNESS_TURN_SPAN) return "Turn";
  if (span.name === HARNESS_RUN_SPAN) return "Prompt";
  return span.name;
};

/**
 * `pi.status` as the panel means it, which is not quite what the schema
 * records. An open span is running whatever its status attribute says — the
 * recorder writes those at close — and that is what makes a live run shimmer
 * without the panel needing to know which attribute belongs to which span.
 */
const statusOf = (span: RecordedSpan): string | undefined => {
  if (span.endTimeMs === null) return "running";

  const recorded = span.attributes["semla.workflow.agent.status"];
  if (typeof recorded === "string") return recorded;
  return span.status.status === "error" ? "error" : undefined;
};

/**
 * The row every prompt hangs from.
 *
 * Each prompt is its own `pi.harness.run`, and pi's schema declares that span
 * as a root — correctly, since a turn is not inside anything pi knows about.
 * That leaves a three-prompt session drawing three top-level bars with nothing
 * tying them together.
 *
 * Synthesised here rather than recorded, and the distinction matters. A real
 * session span would have to stay open across turns, which means one span id
 * shared by every turn's sink, a start time each turn would have to read back
 * off disk to preserve, and an end time that is never actually known — a
 * session ends when someone stops using it. All of that to hold a bar whose
 * bounds are just the extent of its children.
 *
 * So it carries no timing of its own: `startTimeMs` and `endTimeMs` are the
 * min and max of the spans below it. Nothing is inferred — this is an
 * envelope over measured spans, not a measurement — which is why it does not
 * violate §8.5's rule against mixing the two.
 *
 * The id is derived from the trace so it is the same row across re-renders,
 * and a selection or a collapsed state survives new spans arriving.
 */
const SESSION_ROW = "Session";

const sessionRow = (
  children: readonly MsSpan[],
  traceId: string,
): MsSpan => ({
  attributes: {
    // The count is the useful part of a row that has no timing of its own.
    "semla.session.prompts": children.filter((span) => span.name === "Prompt")
      .length,
  },
  endTimeMs: Math.max(...children.map((span) => span.endTimeMs)),
  kind: "INTERNAL",
  name: SESSION_ROW,
  resource: { "service.name": "session" },
  spanId: makeSpanId(`semla-session-${traceId}`),
  startTimeMs: Math.min(...children.map((span) => span.startTimeMs)),
  status: { code: "OK" },
  traceId,
});

export const recordedSpansToOtelSpans = (
  spans: readonly RecordedSpan[],
  options?: { now?: number },
): MsSpan[] => {
  const now = options?.now ?? Date.now();
  const byId = new Map(spans.map((span) => [span.spanId, span]));

  /**
   * The run a span belongs to, by walking up. A phase or an agent needs its
   * run id for click-to-transcript, and only the run span carries one.
   *
   * Guarded against a cycle rather than trusted: these ids arrive over the
   * wire, and a malformed parent chain must not hang the render.
   */
  const runIdOf = (span: RecordedSpan): string | undefined => {
    const seen = new Set<string>();
    let current: RecordedSpan | undefined = span;

    while (current && !seen.has(current.spanId)) {
      seen.add(current.spanId);
      const value = current.attributes["semla.workflow.run_id"];
      if (typeof value === "string") return value;
      current = current.parentSpanId
        ? byId.get(current.parentSpanId)
        : undefined;
    }

    return undefined;
  };

  const mapped: MsSpan[] = spans.map((span): MsSpan => {
    const status = statusOf(span);
    const runId = runIdOf(span);
    const agentId = span.attributes["semla.workflow.agent.id"];

    return {
      attributes: {
        ...coerce(span.attributes),
        ...(status === undefined ? {} : { [STATUS]: status }),
        ...(runId === undefined ? {} : { [RUN_ID]: runId }),
        ...(typeof agentId === "number" ? { [AGENT_ID]: agentId } : {}),
      },
      // An open span is drawn up to the caller's clock, so a running row grows
      // as the panel ticks instead of collapsing to nothing.
      endTimeMs: span.endTimeMs ?? now,
      kind: "INTERNAL",
      name: labelOf(span),
      // A parent outside this set — a turn span from a stream we never saw, or
      // one the cap dropped — would otherwise take its whole subtree out of
      // the tree. Re-rooted instead, so the run still draws.
      ...(span.parentSpanId && byId.has(span.parentSpanId)
        ? { parentSpanId: span.parentSpanId }
        : {}),
      resource: { "service.name": serviceOf(span.name) },
      spanId: span.spanId,
      startTimeMs: span.startTimeMs,
      ...(span.status.status === "error"
        ? {
            status: {
              code: "ERROR" as const,
              ...(span.status.error?.message
                ? { message: span.status.error.message }
                : {}),
            },
          }
        : { status: { code: "OK" as const } }),
      traceId: span.traceId,
    };
  });

  if (mapped.length === 0) return [];

  // Whatever had no parent in the recorded set is a prompt (or a background
  // run recovered with its turn gone), and those are what the session row
  // holds.
  const roots = mapped.filter((span) => span.parentSpanId === undefined);
  if (roots.length === 0) return mapped;

  const row = sessionRow(roots, mapped[0]?.traceId ?? "");

  return [
    row,
    ...mapped.map((span) =>
      span.parentSpanId === undefined
        ? { ...span, parentSpanId: row.spanId }
        : span,
    ),
  ];
};

/**
 * Whether recorded spans cover the host session, not just workflows.
 *
 * Until layer 2a lands (plan §6 step 6) the only recorded spans are
 * `semla.workflow.*`, so a recorded trace of a session that ran no workflow is
 * empty, and one that did shows the workflow with no conversation around it —
 * strictly less than the derived view offers. This is what the panel defaults
 * on, so the default flips by itself when host spans start arriving rather
 * than needing a second change here.
 */
export const coversHostSession = (spans: readonly RecordedSpan[]): boolean =>
  spans.some((span) => span.name.startsWith("pi.harness."));

export type TimelineSource = "derived" | "recorded";

/**
 * Which timeline to draw, given what has been recorded and what the user
 * picked.
 *
 * Extracted from the panel because it is the only branching in the choice and
 * the panel is not unit-testable here (the vitest environment is `node`, and
 * there is no testing-library). Three rules, in order: an explicit pick wins;
 * with nothing recorded there is only one timeline; otherwise prefer recorded
 * once recording covers the host session.
 */
export const timelineSource = (
  spans: readonly RecordedSpan[],
  override: TimelineSource | null,
): TimelineSource => {
  // An override survives spans arriving later, including the host spans that
  // would otherwise flip the default out from under a user reading a trace.
  if (override) return spans.length > 0 ? override : "derived";
  if (spans.length === 0) return "derived";
  return coversHostSession(spans) ? "recorded" : "derived";
};
