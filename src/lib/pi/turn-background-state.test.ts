/**
 * The branch at the end of every prompt turn: dispose, or stay alive and watch.
 *
 * It used to live inline in runPiPrompt's `finally`, reading three `let`
 * bindings the event subscriber mutated five hundred lines above — so getting
 * it wrong meant either a session disposed with a workflow still running (the
 * panel freezes, the result never arrives) or one held open forever. None of it
 * was reachable by a test without standing up a pi session and a real workflow.
 */
import { describe, expect, it } from "vitest";

import {
  claimBackgroundRun,
  createTurnBackgroundState,
  decideContinuation,
  noteDeliveredDuringPrompt,
  setBackgroundRun,
  type TurnBackgroundState,
} from "./turn-background-state.ts";

const decide = (
  state: TurnBackgroundState,
  {
    terminal = false,
    unfinished,
  }: { terminal?: boolean; unfinished?: string } = {},
) =>
  decideContinuation({
    findUnfinishedRun: () => unfinished,
    isRunTerminal: () => terminal,
    state,
  });

describe("claimBackgroundRun", () => {
  it("takes the claim when the turn has none", () => {
    const state = createTurnBackgroundState();

    expect(claimBackgroundRun(state, "run-1")).toBe(true);
    expect(state).toMatchObject({ hasBackgroundWorkflow: true, runId: "run-1" });
  });

  // A bridge dispatches several runs per turn; only the first primary one is
  // the run the continuation watches.
  it("refuses a second claim and leaves the first run in place", () => {
    const state = createTurnBackgroundState();
    claimBackgroundRun(state, "run-1");

    expect(claimBackgroundRun(state, "run-2")).toBe(false);
    expect(state.runId).toBe("run-1");
  });
});

/**
 * The agent's own `workflow` call is authoritative: it is the run the agent
 * started, so it wins over a bridge dispatch that got in first.
 */
describe("setBackgroundRun", () => {
  it("replaces an earlier claim", () => {
    const state = createTurnBackgroundState();
    claimBackgroundRun(state, "bridge-run");

    setBackgroundRun(state, "workflow-run");

    expect(state.runId).toBe("workflow-run");
  });
});

describe("decideContinuation", () => {
  it("is idle for a turn that started nothing", () => {
    expect(decide(createTurnBackgroundState())).toEqual({ kind: "idle" });
  });

  it("watches a run this turn started", () => {
    const state = createTurnBackgroundState();
    setBackgroundRun(state, "run-1");

    expect(decide(state)).toEqual({
      kind: "watch",
      rearmed: false,
      runId: "run-1",
    });
  });

  /**
   * The workflow outran the prompt turn — pi delivered the result inside the
   * same prompt() call, so the entries are already persisted and there is
   * nothing left to wait for.
   */
  it("settles when a finished run was delivered during the turn", () => {
    const state = createTurnBackgroundState();
    setBackgroundRun(state, "run-1");
    noteDeliveredDuringPrompt(state);

    expect(decide(state, { terminal: true })).toEqual({
      kind: "settled",
      runId: "run-1",
    });
  });

  /**
   * Pi can deliver an interim result while the workflow keeps going. Treating
   * that as settled would dispose the session with the run still live.
   */
  it("keeps watching when a delivery arrived but the run is not terminal", () => {
    const state = createTurnBackgroundState();
    setBackgroundRun(state, "run-1");
    noteDeliveredDuringPrompt(state);

    expect(decide(state, { terminal: false })).toEqual({
      kind: "watch",
      rearmed: false,
      runId: "run-1",
    });
  });

  // Background work was started but its id never surfaced in the tool result,
  // so there is no run file to check — the delivery is all we have to go on.
  it("settles an unidentified run on the delivery alone", () => {
    const state = createTurnBackgroundState();
    state.hasBackgroundWorkflow = true;
    noteDeliveredDuringPrompt(state);

    expect(
      decide(state, {
        terminal: false,
      }),
    ).toEqual({ kind: "settled", runId: undefined });
  });

  /**
   * The case a turn that merely chats used to break: every new prompt stands
   * down the previous continuation, so "how is it going?" would leave an
   * earlier workflow running with nothing watching it.
   */
  it("re-arms for an earlier run when this turn started nothing", () => {
    expect(
      decide(createTurnBackgroundState(), { unfinished: "earlier-run" }),
    ).toEqual({ kind: "watch", rearmed: true, runId: "earlier-run" });
  });

  it("does not look for an earlier run when this turn started one", () => {
    const state = createTurnBackgroundState();
    setBackgroundRun(state, "run-1");

    let looked = false;
    decideContinuation({
      findUnfinishedRun: () => {
        looked = true;
        return "earlier-run";
      },
      isRunTerminal: () => false,
      state,
    });

    expect(looked).toBe(false);
  });

  // Reading the run file costs a stat; a turn with no background work at all
  // must not pay for one.
  it("does not read a run file when there is no run to read", () => {
    let read = false;
    decideContinuation({
      findUnfinishedRun: () => undefined,
      isRunTerminal: () => {
        read = true;
        return true;
      },
      state: createTurnBackgroundState(),
    });

    expect(read).toBe(false);
  });
});
