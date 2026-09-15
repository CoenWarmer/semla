/**
 * Serializes a session's turns so a new prompt never begins touching the
 * session file while an earlier turn still holds it open.
 *
 * docs/plans/superseded-turns.md diagnoses the failure this closes: the
 * operator sent a new prompt 27 seconds into a filesystem-wide `find`, and a
 * fresh turn ran to completion on its own `SessionManager` while the old
 * one's `find` kept running. When it returned 7m45s later, its result was
 * appended by the old turn's own in-memory `SessionManager` as a *second*
 * child of the same parent the new turn had branched from — arriving last,
 * and so becoming the leaf. Nothing was lost, but the leaf rule
 * (`session-path.ts`) means the UI and the model silently diverged the
 * moment that happened.
 *
 * pi's `SessionManager` gives no hook to veto an append once a turn's model
 * starts streaming — persistence happens inside `AgentSession`'s own event
 * handler, unconditionally, the moment a message ends. So the fix available
 * at this seam is not to intercept the append; there is no such hook. It is
 * to make sure a second `SessionManager.open()` of the same file is never
 * attempted while an earlier one is still live: a new turn tells whatever is
 * still running to stand down, and waits for it to actually finish — not
 * merely for its agent loop to settle, but for its own `finally` to
 * complete, since that is what performs the writes — before it opens the
 * file itself.
 *
 * Abort is unconditional here, deliberately blunt. §4 of the plan separates
 * "never append a superseded result" (required, this module) from "which
 * tools survive being aborted" (a later, per-tool refinement, not yet done).
 * A bash command mid-flight when a new prompt arrives is killed along with
 * everything else; narrowing that is left to that later phase.
 *
 * **Why the swap has to be synchronous.** Two prompts for the same session
 * can arrive close enough together that both are past their first `await`
 * before either has registered. If "read who's running" and "announce that
 * I am now the one running" were separate steps with an `await` between
 * them, both could read the same prior turn, both would wait for it, and
 * both would then proceed concurrently — the exact race this exists to
 * close, just moved one step later. `takeTurnSlot` does both in the same
 * synchronous tick, so whichever call runs first is unambiguously the one
 * later calls wait on.
 */

export type TurnSlot = {
  /**
   * Wait for whatever turn was running before this one to abort and
   * completely finish. Resolves immediately if nothing was running.
   */
  waitForPrior: () => Promise<void>;
  /**
   * Replace the abort function this slot offers to whoever waits on it next.
   * Starts as a no-op — `runPiPrompt` has no agent session during extension
   * loading, so a turn superseded in that window is waited out rather than
   * interrupted early.
   */
  updateAbort: (abort: () => Promise<void>) => void;
  /**
   * Mark this turn finished: resolves `settled` for anyone already waiting,
   * and — guarded by identity, so a turn that lost the race to register can
   * never clear the one that displaced it — drops this slot's registration
   * if it is still the current one.
   */
  finish: () => void;
};

type Registered = {
  abort: () => Promise<void>;
  settled: Promise<void>;
};

const current = new Map<string, Registered>();

/**
 * Take this session's turn slot: synchronously hand back the previous
 * occupant (if any) and install this call as the new one, in one tick.
 */
export const takeTurnSlot = (semlaSessionId: string): TurnSlot => {
  const prior = current.get(semlaSessionId);

  let resolveSettled: () => void = () => {};
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  const self: Registered = { abort: () => Promise.resolve(), settled };
  current.set(semlaSessionId, self);

  return {
    finish: () => {
      resolveSettled();
      if (current.get(semlaSessionId) === self) {
        current.delete(semlaSessionId);
      }
    },
    updateAbort: (abort: () => Promise<void>) => {
      self.abort = abort;
    },
    waitForPrior: async () => {
      if (!prior) return;
      await prior.abort().catch(() => {});
      await prior.settled.catch(() => {});
    },
  };
};

/** Whether a turn currently holds this session's slot. For tests. */
export const hasTurnSlot = (semlaSessionId: string): boolean =>
  current.has(semlaSessionId);
