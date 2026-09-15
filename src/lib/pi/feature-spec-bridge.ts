/**
 * Shared in-memory bridge between the `capture_feature_spec` Pi extension
 * (loaded via factory inside pi-coding-agent) and the
 * /feature-spec-answer API route.
 *
 * Same shape as ask-user-bridge.ts, and for the same reason: the extension
 * runs inside the agent's process, the answer arrives over an HTTP request
 * from the browser, and `Symbol.for` keeps the registry shared across module
 * contexts even if the two sides were loaded from different module graphs —
 * the same pattern as workflow-manager-registry.ts / workflow-progress-bridge.ts.
 */

/** The fixed set of fields the form captures. Free text, one block each. */
export type FeatureSpecAnswers = {
  goal: string;
  functionalRequirements: string;
  nonFunctionalRequirements: string;
};

type PendingEntry = {
  reject: (err: Error) => void;
  resolve: (answers: FeatureSpecAnswers) => void;
};

type NotifierFn = () => void;

const PENDING_KEY = Symbol.for("semla.feature-spec.pending");
const NOTIFIER_KEY = Symbol.for("semla.feature-spec.notifiers");

const g = globalThis as Record<symbol, unknown>;
g[PENDING_KEY] ??= new Map<string, PendingEntry>();
g[NOTIFIER_KEY] ??= new Map<string, NotifierFn>();

const pending = g[PENDING_KEY] as Map<string, PendingEntry>;
const notifiers = g[NOTIFIER_KEY] as Map<string, NotifierFn>;

/**
 * Called by session-service before starting a session to wire up the SSE
 * notifier. Returns a cleanup function that removes the notifier on session end.
 */
export const registerFeatureSpecNotifier = (
  sessionId: string,
  notifier: NotifierFn,
): (() => void) => {
  notifiers.set(sessionId, notifier);
  return () => notifiers.delete(sessionId);
};

/**
 * Called by the feature-spec extension's execute() function. Pushes the
 * request to the SSE stream and waits for the user to fill in and submit the
 * form.
 */
export const waitForFeatureSpec = (
  sessionId: string,
  signal?: AbortSignal,
): Promise<FeatureSpecAnswers> => {
  const notifier = notifiers.get(sessionId);
  if (!notifier) {
    return Promise.reject(
      new Error(`capture_feature_spec: no active session for ${sessionId}`),
    );
  }

  return new Promise<FeatureSpecAnswers>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("capture_feature_spec cancelled"));
      return;
    }

    pending.set(sessionId, { reject, resolve });

    signal?.addEventListener("abort", () => {
      if (pending.get(sessionId)?.reject === reject) {
        pending.delete(sessionId);
        reject(new Error("capture_feature_spec cancelled"));
      }
    });

    notifier();
  });
};

/**
 * Called by the /feature-spec-answer API route when the user submits the
 * form. Returns true if there was a pending request, false if nothing was
 * waiting.
 */
export const deliverFeatureSpec = (
  sessionId: string,
  answers: FeatureSpecAnswers,
): boolean => {
  const entry = pending.get(sessionId);
  if (!entry) return false;
  pending.delete(sessionId);
  entry.resolve(answers);
  return true;
};
