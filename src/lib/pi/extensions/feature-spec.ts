/**
 * The `capture_feature_spec` tool: render a fixed-shape form in the browser
 * — overarching goal, functional requirements, non-functional requirements —
 * and wait for the user to fill it in.
 *
 * Same shape as ask-user.ts: the tool has no UI of its own inside pi (Semla
 * renders no TUI), so it hands the request to feature-spec-bridge.ts, which
 * the session's SSE stream turns into an `ui-request` the browser renders,
 * and waits for the answer to come back over
 * /api/sessions/[id]/feature-spec-answer.
 *
 * Unlike ask_user the fields are fixed rather than agent-specified: the point
 * of this tool is a stable place to capture a feature's spec, not a general
 * question form, so there is nothing for the model to configure per call.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  waitForFeatureSpec,
  type FeatureSpecAnswers,
} from "../bridge/feature-spec-bridge";

// No parameters: the fields are fixed, so there is nothing for the model to
// pass beyond triggering the tool.
const FeatureSpecSchema = Type.Object({}, { additionalProperties: false });

const FIELD_LABELS: Record<keyof FeatureSpecAnswers, string> = {
  functionalRequirements: "Functional requirements",
  goal: "Overarching goal",
  nonFunctionalRequirements: "Non-functional requirements",
};

export default function featureSpecExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "capture_feature_spec",
    label: "Capture feature spec",
    description:
      "Render a form for the user to fill in the specification of a feature: its " +
      "overarching goal, its functional requirements, and its non-functional " +
      "requirements. Use when a feature is broad enough that its scope should be " +
      "captured explicitly before design or implementation starts, rather than " +
      "inferred piecemeal from conversation.",
    promptGuidelines: [
      "Use once per feature, before significant design or implementation work begins.",
      "Do not use for a small, already-unambiguous change — this tool is for capturing scope, not for every request.",
      "Treat the returned text as the feature's spec of record for the rest of the session.",
    ],
    parameters: FeatureSpecSchema,
    executionMode: "sequential",
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      const sessionId = ctx.sessionManager.getSessionId();

      let answers: FeatureSpecAnswers;
      try {
        answers = await waitForFeatureSpec(sessionId, signal ?? undefined);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            { type: "text", text: `capture_feature_spec was cancelled: ${msg}` },
          ],
          details: null,
          isError: true,
        };
      }

      const lines = (Object.keys(FIELD_LABELS) as (keyof FeatureSpecAnswers)[]).map(
        (key) => `${FIELD_LABELS[key]}\n→ ${answers[key] || "(none given)"}`,
      );

      return {
        content: [{ type: "text", text: lines.join("\n\n") }],
        details: answers,
      };
    },
  });
}
