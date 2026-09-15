/**
 * A per-session request/response rendezvous between a tool's `execute()` and an
 * HTTP route.
 *
 * `ask_user` and `capture_feature_spec` both need the same thing, and it is not
 * a shape pi provides: a tool running inside the agent process has to ask the
 * browser something and block until the answer arrives on a *later, unrelated*
 * HTTP request. Pi's own prompting surfaces are all TUI, and Semla renders no
 * TUI, so the round trip has to leave the process and come back.
 *
 * Three moves, which is the whole mechanism:
 *
 *  - `registerNotifier` — session-service, at turn start, hands over the
 *    session's outbound channel (it emits onto the SSE stream the browser is
 *    already reading). Returns the cleanup for turn end.
 *  - `waitFor` — the tool calls this and gets a promise. It fires the notifier
 *    to open the UI, then blocks.
 *  - `deliver` — the API route calls this when the user submits, which settles
 *    the tool's promise. `false` means nothing was waiting, which is the answer
 *    a route needs in order to 409 rather than pretend.
 *
 * ## Why this file exists
 *
 * There were two copies of it — `ask-user-bridge.ts` and
 * `feature-spec-bridge.ts`, ~100 lines each, the second's docblock saying "Same
 * shape as ask-user-bridge.ts". Each also declared its own `Symbol.for` pair
 * outside extension-contract.ts, which is the bypass that module exists to make
 * impossible. The abort guard below is the kind of detail that was duplicated
 * and could have drifted in one copy without the other.
 *
 * ## The session id
 *
 * One string keys everything, and both ends can see it: the route reads it from
 * its URL, the tool reads it from `ctx.sessionManager.getSessionId()`. Those
 * agree because Semla writes the Semla session id into the pi session header —
 * see the SessionKeyedSlotKey docblock in extension-contract.ts, which is where
 * that invariant is written down.
 *
 * State lives in a `globalThis` contract slot rather than a module-level `Map`
 * because the tool side and the route side are not guaranteed to be the same
 * module instance: extensions load through pi, routes through Next, and a
 * second copy of this module would be a second registry that neither half of a
 * pending call could see.
 */

import {
  readOrInitSlot,
  type RendezvousSlotKey,
  type RendezvousWaiter,
} from "../extension-loading/extension-contract";

/**
 * Function-typed properties rather than methods, deliberately: the three are
 * re-exported directly (`export const waitForAnswer = rendezvous.waitFor`), and
 * method syntax makes that an unbound-method lint error. None of them touch
 * `this`.
 */
export type SessionRendezvous<TRequest, TResponse> = {
  /**
   * Publish the session's outbound channel. Returns the cleanup, which is
   * identity-guarded: it removes this notifier only if it is still the current
   * one, so a turn that has already been superseded cannot unregister the turn
   * that displaced it. Turns are serialised per session by session-turn-lock.ts,
   * so that overlap should not arise — but the same clear was unguarded on
   * BRIDGE_RUN_STARTED, where it silently left a live session with no notifier
   * at all, and the guard costs one comparison.
   */
  registerNotifier: (
    sessionId: string,
    notify: (request: TRequest) => void,
  ) => () => void;

  /**
   * Ask the browser and wait. Rejects immediately if the session has no
   * notifier — a tool called outside a live turn, which is a real failure and
   * not something to hang on — and on abort.
   */
  waitFor: (
    sessionId: string,
    request: TRequest,
    signal?: AbortSignal,
  ) => Promise<TResponse>;

  /** Settle the waiting call. `false` when nothing was waiting. */
  deliver: (sessionId: string, response: TResponse) => boolean;
};

export function createSessionRendezvous<TRequest, TResponse>(options: {
  /** The contract slot holding this rendezvous' state. */
  slot: RendezvousSlotKey;
  /** The tool's name, used verbatim so a rejection reads as the tool's own. */
  toolName: string;
}): SessionRendezvous<TRequest, TResponse> {
  const { slot, toolName } = options;

  // Read per call rather than once at module scope: the slot may be initialised
  // by whichever side of the divide runs first, and capturing it here would
  // freeze in a map created before the other side existed.
  const state = () =>
    readOrInitSlot(slot, () => ({
      notifiers: new Map(),
      waiting: new Map(),
    }));

  return {
    deliver: (sessionId, response) => {
      const { waiting } = state();
      const waiter = waiting.get(sessionId);
      if (!waiter) return false;
      waiting.delete(sessionId);
      waiter.resolve(response);
      return true;
    },

    registerNotifier: (sessionId, notify) => {
      const { notifiers } = state();
      const entry = notify as (request: unknown) => void;
      notifiers.set(sessionId, entry);
      return () => {
        const current = state().notifiers;
        if (current.get(sessionId) === entry) current.delete(sessionId);
      };
    },

    waitFor: (sessionId, request, signal) => {
      const { notifiers, waiting } = state();
      const notify = notifiers.get(sessionId);
      if (!notify) {
        return Promise.reject(
          new Error(`${toolName}: no active session for ${sessionId}`),
        );
      }

      return new Promise<TResponse>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error(`${toolName} cancelled`));
          return;
        }

        // A second call for the same session displaces the first, so settle the
        // first rather than dropping it. Both bridges this replaced just
        // overwrote the map entry, which left the displaced promise unsettled
        // for the life of the process — and it is awaited inside a tool's
        // execute(), so that is a wedged agent loop rather than a lost answer.
        // Turns are serialised per session, so this should not arise; it used
        // to fail by hanging, and now fails by saying so.
        const displaced = waiting.get(sessionId);
        if (displaced) {
          displaced.reject(
            new Error(`${toolName}: superseded by a newer request`),
          );
        }

        const waiter: RendezvousWaiter = {
          reject,
          resolve: resolve as (response: unknown) => void,
        };
        waiting.set(sessionId, waiter);

        // Identity-guarded for the same reason as the unregister above: by the
        // time an abort fires, the entry may belong to a later call.
        signal?.addEventListener("abort", () => {
          if (waiting.get(sessionId) !== waiter) return;
          waiting.delete(sessionId);
          reject(new Error(`${toolName} cancelled`));
        });

        notify(request);
      });
    },
  };
}
