import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  deliverAnswer,
  waitForAnswer,
  type AskUserAnswers,
} from "../ask-user-bridge.js";

const OptionSchema = Type.Object({
  value: Type.String(),
  label: Type.String(),
  description: Type.Optional(Type.String()),
});

const QuestionSchema = Type.Object({
  id: Type.String({ description: "Unique identifier for this question, used as the answer key." }),
  question: Type.String({ description: "The question text shown to the user." }),
  description: Type.Optional(Type.String({ description: "Optional additional context below the question." })),
  type: Type.Union(
    [
      Type.Literal("single", { description: "User picks exactly one option." }),
      Type.Literal("multiple", { description: "User may pick several options." }),
      Type.Literal("text", { description: "User types a free-form answer." }),
    ],
    { description: "Answer input type." },
  ),
  options: Type.Optional(
    Type.Array(OptionSchema, {
      description: "Choices for single/multiple questions.",
      minItems: 2,
    }),
  ),
});

const AskUserSchema = Type.Object({
  questions: Type.Array(QuestionSchema, {
    description: "One to four questions presented to the user.",
    minItems: 1,
    maxItems: 4,
  }),
});

export default function askUserExtension(api: ExtensionAPI) {
  api.registerTool({
    name: "ask_user",
    label: "Ask user",
    description:
      "Present one to four structured questions to the user and wait for their answers before continuing. " +
      "Use only when you face genuine ambiguity that cannot be resolved from context alone. " +
      "Do not use this tool speculatively or when a reasonable default exists.",
    promptGuidelines: [
      "Ask at most 4 questions per call; batch related decisions into one call.",
      "Do not ask questions whose answers are already implied by the conversation.",
      "For single/multiple choice, supply 2–6 meaningful options; avoid catch-all 'other' unless necessary.",
    ],
    parameters: AskUserSchema,
    executionMode: "sequential",
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const sessionId = ctx.sessionManager.getSessionId();

      let answers: AskUserAnswers;
      try {
        answers = await waitForAnswer(sessionId, { questions: params.questions }, signal ?? undefined);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `ask_user was cancelled: ${msg}` }],
          details: null,
          isError: true,
        };
      }

      const lines = params.questions.map((q) => {
        const answer = answers[q.id] ?? "(no answer)";
        return `${q.question}\n→ ${answer}`;
      });

      return {
        content: [{ type: "text", text: lines.join("\n\n") }],
        details: answers,
      };
    },
  });
}

// Re-export deliverAnswer so the answer API route can import it from this
// module path without needing to know about the bridge directly. Not used
// internally — the API route imports from ask-user-bridge directly.
export { deliverAnswer };
