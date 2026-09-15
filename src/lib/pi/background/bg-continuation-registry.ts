/**
 * Background continuations currently watching a session, so a new prompt can
 * take one over.
 *
 * A continuation outlives the prompt turn that armed it: it holds the pi
 * session open to receive the report turn pi delivers when a background
 * workflow finishes. When the next prompt arrives for the same session,
 * pi re-targets delivery to the newly loaded session, so the old continuation
 * has nothing left to wait for and must stand down.
 *
 * It is aborted rather than disposed. Disposing would kill the shared bash
 * executor and abort the new turn's in-flight tool calls — see the
 * `supersededByNewPrompt` branch in background-continuation.ts, which is what
 * the abort signal reaches.
 *
 * Process-local, like the session registries beside it: an AbortController
 * cannot be serialised, and a stop request arriving at a process that is not
 * running the continuation honestly finds nothing.
 */

const continuations = new Map<string, AbortController>();

/**
 * Register a continuation for this session and hand back the signal it should
 * watch. Replaces any existing entry without aborting it — callers that need
 * the previous one stood down call `abortBackgroundContinuation` first.
 */
export const armBackgroundContinuation = (
  semlaSessionId: string,
): AbortSignal => {
  const controller = new AbortController();
  continuations.set(semlaSessionId, controller);
  return controller.signal;
};

/**
 * Whether a continuation is watching this session.
 *
 * Read by `isSessionActive` to tell a genuinely running session from a running
 * flag left behind by a process that is no longer here.
 */
export const hasBackgroundContinuation = (semlaSessionId: string): boolean =>
  continuations.has(semlaSessionId);

/**
 * Stand down this session's continuation, reporting whether there was one.
 *
 * The entry is dropped either way, so a caller that only wants it gone can
 * ignore the result.
 */
export const abortBackgroundContinuation = (
  semlaSessionId: string,
): boolean => {
  const controller = continuations.get(semlaSessionId);
  continuations.delete(semlaSessionId);
  controller?.abort();
  return controller !== undefined;
};

/**
 * Drop a continuation's own registration as it tears itself down.
 *
 * Identified by the signal it was armed with, so a continuation that has been
 * superseded cannot deregister the one that replaced it: the superseding prompt
 * arms its continuation in the same `finally` that the old one is unwinding
 * through, and an unconditional delete would leave the new continuation
 * unreachable — `isSessionActive` would report the session idle and a stop
 * request would find nothing to abort.
 */
export const releaseBackgroundContinuation = (
  semlaSessionId: string,
  signal: AbortSignal,
): void => {
  if (continuations.get(semlaSessionId)?.signal === signal) {
    continuations.delete(semlaSessionId);
  }
};
