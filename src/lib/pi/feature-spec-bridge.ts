/**
 * The `capture_feature_spec` rendezvous: the form's field types, and the three
 * calls that open it in the browser and carry the filled-in answers back.
 *
 * The mechanism is session-rendezvous.ts, which ask-user-bridge.ts shares.
 * Unlike ask_user there is no request payload — the fields are fixed, so the
 * only thing to send is the fact that the form should open, which is why
 * `waitForFeatureSpec` takes no request argument.
 */

import { FEATURE_SPEC_RENDEZVOUS } from "./extension-contract";
import { createSessionRendezvous } from "./session/session-rendezvous";

/** The fixed set of fields the form captures. Free text, one block each. */
export type FeatureSpecAnswers = {
  goal: string;
  functionalRequirements: string;
  nonFunctionalRequirements: string;
};

const rendezvous = createSessionRendezvous<void, FeatureSpecAnswers>({
  slot: FEATURE_SPEC_RENDEZVOUS,
  toolName: "capture_feature_spec",
});

/**
 * Called by session-service at turn start to wire up the SSE notifier. Returns
 * a cleanup function that removes it at turn end.
 */
export const registerFeatureSpecNotifier = rendezvous.registerNotifier;

/**
 * Called by the feature-spec extension's execute(): opens the form and waits
 * for the user to submit it.
 */
export const waitForFeatureSpec = (
  sessionId: string,
  signal?: AbortSignal,
): Promise<FeatureSpecAnswers> =>
  rendezvous.waitFor(sessionId, undefined, signal);

/**
 * Called by the /feature-spec-answer API route when the user submits. Returns
 * false if nothing was waiting.
 */
export const deliverFeatureSpec = rendezvous.deliver;
