/**
 * What a prompt turn learned about background work while it was streaming, and
 * the decision that follows from it.
 *
 * These three facts are discovered by the agent event stream — a `workflow`
 * tool returning a background run, a bridge dispatching one, pi delivering a
 * result mid-turn — and are read once the turn ends to decide whether anything
 * still needs watching. They used to be three `let` bindings in runPiPrompt,
 * mutated from inside the event subscriber and read from the `finally` block
 * five hundred lines apart, which is why the ordering hazard documented on
 * `attachedThisTurn` was possible at all.
 *
 * Naming them makes the seam explicit: the router writes, the lifecycle reads,
 * and `decideContinuation` — the branch that actually matters — becomes a pure
 * function of the two.
 */

export type TurnBackgroundState = {
  /**
   * Pi delivered a workflow result inside the prompt turn.
   *
   * A short background workflow can finish while the turn is still streaming.
   * Pi then delivers the result as a follow-up inside the same prompt() call,
   * so there is nothing left for a continuation to wait for.
   */
  deliveredDuringPrompt: boolean;
  /** A background workflow was started by this turn. */
  hasBackgroundWorkflow: boolean;
  /**
   * The run this turn is responsible for, when one was identified. A workflow
   * can be known to be running in the background without its id being
   * recoverable from the tool result, which is why this is independent of
   * `hasBackgroundWorkflow` rather than implied by it.
   */
  runId: string | undefined;
};

export const createTurnBackgroundState = (): TurnBackgroundState => ({
  deliveredDuringPrompt: false,
  hasBackgroundWorkflow: false,
  runId: undefined,
});

/**
 * Claim this turn's background run, if it has not already been claimed.
 *
 * Reports whether the claim was taken. A bridge-dispatched run announces itself
 * for persistence and the UI whether or not it is the run this turn watches, so
 * the caller needs to know which it got.
 */
export const claimBackgroundRun = (
  state: TurnBackgroundState,
  runId: string,
): boolean => {
  if (state.hasBackgroundWorkflow) return false;
  state.hasBackgroundWorkflow = true;
  state.runId = runId;
  return true;
};

/**
 * Record the background run this turn is responsible for, replacing any earlier
 * claim.
 *
 * The `workflow` tool reporting a background run is the authoritative signal —
 * it is the run the agent itself started — so it takes precedence over a claim
 * a bridge dispatch got in first.
 */
export const setBackgroundRun = (
  state: TurnBackgroundState,
  runId: string,
): void => {
  state.hasBackgroundWorkflow = true;
  state.runId = runId;
};

export const noteDeliveredDuringPrompt = (
  state: TurnBackgroundState,
): void => {
  state.deliveredDuringPrompt = true;
};

/**
 * What the turn should do about background work now that it has ended.
 *
 * `settled` — the workflow outran the prompt turn. Its result is already
 * delivered and persisted, so the run can be finalised and the session let go.
 *
 * `watch` — something is still in flight. The session stays alive so it can
 * receive progress and the report turn pi delivers on completion. `rearmed`
 * marks the case where the run was *not* started by this turn: every new prompt
 * stands down the previous continuation, so a turn that merely chats — "how is
 * it going?" — would otherwise leave an earlier workflow running with nothing
 * watching it, and the running flag has to be set back on.
 *
 * `idle` — nothing to watch; dispose.
 */
export type ContinuationDecision =
  | { kind: "settled"; runId: string | undefined }
  | { kind: "watch"; rearmed: boolean; runId: string | undefined }
  | { kind: "idle" };

/**
 * The lookups are passed as thunks rather than values because both read the
 * filesystem and neither is needed on every path.
 */
export const decideContinuation = ({
  findUnfinishedRun,
  isRunTerminal,
  state,
}: {
  /** The session's most recent unfinished run, for the re-arming case. */
  findUnfinishedRun: () => string | undefined;
  isRunTerminal: (runId: string) => boolean;
  state: TurnBackgroundState;
}): ContinuationDecision => {
  // A delivery seen mid-turn only settles the run if the run is actually over:
  // pi can deliver an interim result while the workflow keeps going.
  const settled =
    state.deliveredDuringPrompt &&
    (!state.runId || isRunTerminal(state.runId));

  if (state.hasBackgroundWorkflow && settled) {
    return { kind: "settled", runId: state.runId };
  }

  const runId = state.hasBackgroundWorkflow ? state.runId : findUnfinishedRun();

  if (state.hasBackgroundWorkflow || runId) {
    return { kind: "watch", rearmed: !state.hasBackgroundWorkflow, runId };
  }

  return { kind: "idle" };
};
