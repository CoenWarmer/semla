/**
 * Shared in-memory bridge between the ask-user Pi extension (loaded via
 * dynamic import inside pi-coding-agent) and the /answer-question API route.
 *
 * Uses Symbol.for so the registry is shared across module contexts — the same
 * pattern as workflow-manager-registry.ts / workflow-progress-bridge.ts.
 */

export type AskUserOption = {
  value: string;
  label: string;
  description?: string;
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

type PendingEntry = {
  reject: (err: Error) => void;
  resolve: (answers: AskUserAnswers) => void;
};

type NotifierFn = (payload: AskUserPayload) => void;

const PENDING_KEY = Symbol.for("semla.ask-user.pending");
const NOTIFIER_KEY = Symbol.for("semla.ask-user.notifiers");

const g = globalThis as Record<symbol, unknown>;
g[PENDING_KEY] ??= new Map<string, PendingEntry>();
g[NOTIFIER_KEY] ??= new Map<string, NotifierFn>();

const pending = g[PENDING_KEY] as Map<string, PendingEntry>;
const notifiers = g[NOTIFIER_KEY] as Map<string, NotifierFn>;

/**
 * Called by session-service before starting a session to wire up the SSE
 * notifier. Returns a cleanup function that removes the notifier on session end.
 */
export const registerNotifier = (
  sessionId: string,
  notifier: NotifierFn,
): (() => void) => {
  notifiers.set(sessionId, notifier);
  return () => notifiers.delete(sessionId);
};

/**
 * Called by the ask-user extension's execute() function. Pushes the question
 * to the SSE stream and waits for the user's answer.
 */
export const waitForAnswer = (
  sessionId: string,
  payload: AskUserPayload,
  signal?: AbortSignal,
): Promise<AskUserAnswers> => {
  const notifier = notifiers.get(sessionId);
  if (!notifier) {
    return Promise.reject(
      new Error(`ask_user: no active session for ${sessionId}`),
    );
  }

  return new Promise<AskUserAnswers>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("ask_user cancelled"));
      return;
    }

    pending.set(sessionId, { reject, resolve });

    signal?.addEventListener("abort", () => {
      if (pending.get(sessionId)?.reject === reject) {
        pending.delete(sessionId);
        reject(new Error("ask_user cancelled"));
      }
    });

    notifier(payload);
  });
};

/**
 * Called by the /answer-question API route when the user submits their answers.
 * Returns true if there was a pending question, false if nothing was waiting.
 */
export const deliverAnswer = (
  sessionId: string,
  answers: AskUserAnswers,
): boolean => {
  const entry = pending.get(sessionId);
  if (!entry) return false;
  pending.delete(sessionId);
  entry.resolve(answers);
  return true;
};
