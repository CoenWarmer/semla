/**
 * The `ask_user` rendezvous: the tool's question types, and the three calls
 * that carry a question to the browser and an answer back.
 *
 * The mechanism is session-rendezvous.ts, which feature-spec-bridge.ts shares.
 * What belongs here is only what is specific to this tool: the shape of a
 * question, the shape of an answer, and the tool's name for error messages.
 */

import { ASK_USER_RENDEZVOUS } from "../extension-loading/extension-contract";
import { createSessionRendezvous } from "../session/session-rendezvous";

export type AskUserOption = {
  value: string;
  label: string;
  description?: string;
  /**
   * Marks this option as an "other, please specify" slot — see the
   * matching field in ask-user.ts's OptionSchema. The dialog renders a
   * nested text input for it and, once the user types into it, the typed
   * text is the answer rather than this option's value.
   */
  allowFreeText?: boolean;
};

export type AskUserQuestion = {
  id: string;
  question: string;
  description?: string;
  type: "single" | "multiple" | "text";
  options?: AskUserOption[];
};

export type AskUserPayload = {
  questions: AskUserQuestion[];
};

/** Answers keyed by question id. For "multiple" type, value is comma-separated. */
export type AskUserAnswers = Record<string, string>;

const rendezvous = createSessionRendezvous<AskUserPayload, AskUserAnswers>({
  slot: ASK_USER_RENDEZVOUS,
  toolName: "ask_user",
});

/**
 * Called by session-service at turn start to wire up the SSE notifier. Returns
 * a cleanup function that removes it at turn end.
 */
export const registerNotifier = rendezvous.registerNotifier;

/**
 * Called by the ask-user extension's execute(): pushes the questions to the
 * SSE stream and waits for the user's answers.
 */
export const waitForAnswer = rendezvous.waitFor;

/**
 * Called by the /answer-question API route when the user submits. Returns
 * false if nothing was waiting.
 */
export const deliverAnswer = rendezvous.deliver;
