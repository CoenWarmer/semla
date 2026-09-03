/**
 * The turn itself, and the tools it calls.
 *
 * Layer 2a of docs/plans/agent-telemetry.md: derived from the events the
 * router already handles, so nothing new has to be observed. Until this
 * existed the only recorded spans were `semla.workflow.*`, which meant a
 * recorded trace of an ordinary prompt was empty and one of a workflow showed
 * the run with no conversation around it.
 *
 * **Uses pi's own span names and attribute keys**, not names of our own. Those
 * are declared in `HARNESS_TELEMETRY_SCHEMA`, so a span recorded here is the
 * same span pi would emit if `createAgentSession` forwarded a telemetry
 * context (step 7) — and the sink reads sensitivity from the schemas, so an
 * invented key is one redaction would silently miss.
 *
 * **Why a run span as well as a turn**, when the two have nearly identical
 * durations: `pi.harness.turn` declares no end attributes at all, so there is
 * nowhere on it to say the turn failed. `pi.harness.run` carries
 * `pi.operation.outcome` and `pi.error.*`. Without it a failed turn is a row
 * that simply stops, indistinguishable from one that finished.
 */

import { randomUUID } from "node:crypto";

import type { OpenSpan, SpanSink } from "@/lib/pi/telemetry/span-sink";

export const HARNESS_RUN_SPAN = "pi.harness.run";
export const HARNESS_TURN_SPAN = "pi.harness.turn";
export const HARNESS_TOOL_SPAN = "pi.harness.tool";
export const HARNESS_STEP_SPAN = "pi.harness.step";

/** Pi's own vocabulary. `run` is the only value its schema allows. */
const OPERATION_KIND = "run";
/** Pi models concurrent work as lanes; a Semla turn is always the main one. */
const LANE = "main";

/**
 * How much of the prompt to record.
 *
 * Enough to label a row and to read in the detail drawer, and bounded because
 * the transcript already holds the whole prompt — the span file is appended to
 * twice per span and should not become a second copy of the conversation. The
 * panel shows far less than this; keeping the excerpt wider than the label
 * means the label can be widened without re-recording anything.
 *
 * The same bound `workflow-spans.ts` already uses for a subagent's prompt.
 */
const PROMPT_EXCERPT_CHARS = 200;

export type TurnOutcome = "aborted" | "completed" | "failed" | "suspended";

export type HostTelemetry = {
  /**
   * The turn's span id, for anything that nests under it — a workflow run
   * does (plan §8.4). Null before `turnStarted`.
   */
  readonly turnSpanId: string | null;
  /**
   * A model round trip finished. `usage` is what the assistant message
   * reported, when it reported any.
   */
  stepEnded: (usage?: { cost: number; tokens: number }) => void;
  /**
   * A model round trip began.
   *
   * This is what step 7 of the plan wanted from `pi.ai.request`, arrived at
   * differently: that span is declared in pi's schema but nothing in either
   * package ever calls `startAiSpan`, so forwarding a telemetry context into
   * `createAgentSession` would have produced no spans at all. The events are
   * already here, so the round trip is derived from them like everything else
   * in layer 2a.
   */
  stepStarted: () => void;
  toolEnded: (callId: string, result: { isError?: boolean }) => void;
  toolStarted: (callId: string, tool: { name: string }) => void;
  /**
   * Close the turn.
   *
   * Safe to call twice, and safe to call for a turn that never started: a
   * dropped stream and a thrown turn both reach the same `finally`.
   */
  turnEnded: (
    outcome: TurnOutcome,
    error?: { code?: string; type?: string },
  ) => void;
  turnStarted: (prompt?: { text: string }) => void;
};

/** A no-op, for a code path with no sink. */
export const NO_HOST_TELEMETRY: HostTelemetry = {
  turnSpanId: null,
  stepEnded: () => {},
  stepStarted: () => {},
  toolEnded: () => {},
  toolStarted: () => {},
  turnEnded: () => {},
  turnStarted: () => {},
};

export const createHostTelemetry = (
  sink: SpanSink,
  { piSessionId }: { piSessionId: string },
): HostTelemetry => {
  const operationId = randomUUID();
  const turnId = randomUUID();
  const tools = new Map<string, OpenSpan>();

  let run: OpenSpan | null = null;
  let turn: OpenSpan | null = null;
  /**
   * The model round trip in flight. One at a time: the agent loop waits for a
   * message to finish before starting the next.
   */
  let step: OpenSpan | null = null;
  let stepAttempt = 0;

  return {
    get turnSpanId() {
      return turn?.spanId ?? null;
    },

    turnStarted: (prompt) => {
      // Idempotent, so a retried start cannot open a second pair.
      if (run) return;

      const excerpt = prompt?.text.slice(0, PROMPT_EXCERPT_CHARS);

      run = sink.openSpan({
        attributes: {
          "pi.lane.name": LANE,
          "pi.operation.id": operationId,
          "pi.operation.kind": OPERATION_KIND,
          "pi.operation.recovery": false,
          "pi.session.id": piSessionId,
          ...(excerpt ? { "semla.prompt.excerpt": excerpt } : {}),
        },
        name: HARNESS_RUN_SPAN,
      });

      turn = sink.openSpan({
        attributes: {
          "pi.lane.name": LANE,
          "pi.operation.id": operationId,
          "pi.turn.id": turnId,
        },
        name: HARNESS_TURN_SPAN,
        parentSpanId: run.spanId,
      });
    },

    stepStarted: () => {
      // No turn means nothing to hang from, and re-rooting would draw the
      // round trip as a sibling of the turn it belongs to.
      if (!turn) return;
      // A `message_start` without an intervening end is a round trip nobody
      // closed. Close it rather than leaking, and let the new one open.
      step?.close({
        status: "error",
        error: { message: "superseded", name: "StepAbandoned" },
      });

      step = sink.openSpan({
        attributes: {
          "pi.lane.name": LANE,
          "pi.operation.id": operationId,
          // Compaction and branch summaries are the other kinds pi declares;
          // this path only ever sees the assistant's own turns.
          "pi.step.attempt": stepAttempt++,
          "pi.step.kind": "assistant",
        },
        name: HARNESS_STEP_SPAN,
        parentSpanId: turn.spanId,
      });
    },

    stepEnded: (usage) => {
      if (!step) return;

      step.setAttributes({
        "pi.step.outcome": "succeeded",
        // pi's schema records no usage on a step, and inventing keys in its
        // namespace is what the sink's redaction lookup cannot see. These are
        // the OTel gen_ai names the derived timeline already uses for an
        // agent, declared in Semla's own schema.
        ...(usage
          ? {
              "gen_ai.usage.cost": usage.cost,
              "gen_ai.usage.total_tokens": usage.tokens,
            }
          : {}),
      });
      step.close({ status: "ok" });
      step = null;
    },

    toolStarted: (callId, { name }) => {
      // A tool call before the turn opened would have nothing to hang from,
      // and re-rooting it would draw it as a sibling of the turn.
      if (!turn) return;

      tools.set(
        callId,
        sink.openSpan({
          attributes: {
            "pi.lane.name": LANE,
            "pi.operation.id": operationId,
            "pi.tool.call_id": callId,
            "pi.tool.name": name,
            // Pi's schema types this as a string enum, not a boolean.
            "pi.tool.replay": "never",
            "pi.tool.recovery": false,
            "pi.turn.id": turnId,
          },
          name: HARNESS_TOOL_SPAN,
          parentSpanId: turn.spanId,
        }),
      );
    },

    toolEnded: (callId, { isError }) => {
      const span = tools.get(callId);
      if (!span) return;

      span.setAttributes({ "pi.tool.is_error": isError === true });
      span.close(
        isError
          ? { status: "error", error: { message: "tool failed", name: "ToolError" } }
          : { status: "ok" },
      );
      tools.delete(callId);
    },

    turnEnded: (outcome, error) => {
      // A tool still open when the turn ends never reported back — an abort,
      // or a crash between its start and end. Closed as an error rather than
      // left open, so the trace does not claim it is still running.
      for (const span of tools.values()) {
        span.close({
          status: "error",
          error: { message: "turn ended first", name: "ToolAbandoned" },
        });
      }
      tools.clear();

      // A round trip still open when the turn ends never reported back.
      step?.close({
        status: "error",
        error: { message: "turn ended first", name: "StepAbandoned" },
      });
      step = null;

      turn?.close(
        outcome === "completed"
          ? { status: "ok" }
          : { status: "error", error: { message: outcome, name: "TurnFailed" } },
      );

      run?.setAttributes({
        "pi.operation.outcome": outcome,
        ...(error?.code ? { "pi.error.code": error.code } : {}),
        ...(error?.type ? { "pi.error.type": error.type } : {}),
      });
      run?.close(
        outcome === "completed"
          ? { status: "ok" }
          : { status: "error", error: { message: outcome, name: "RunFailed" } },
      );
    },
  };
};
