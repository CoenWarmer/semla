/**
 * Two sessions running turns at once must not reach each other's contract
 * slots.
 *
 * Semla permits this by construction: `session-turn-lock.ts` keys its registry
 * by session, so it serialises turns *within* a session and deliberately does
 * not across them — which is the concurrency `session-concurrency.ts` exists to
 * surface rather than prevent. Three slots are session-scoped in meaning;
 * `WIKI_SESSION_REPOS` was keyed from the start and the other two were not, and
 * these tests pin the fixes for both halves of what that cost:
 *
 *  - **Last writer wins.** A second session publishing its workflow manager or
 *    its bridge-run notifier replaced the first's, so a wiki ingest dispatched
 *    by session A ran on B's manager and its run was announced to B's event
 *    router. Nothing errored; the work simply landed in the wrong session.
 *  - **Unguarded clear.** The turn-end clear took the whole slot, so whichever
 *    of two concurrent turns ended first removed the other's notifier. The read
 *    side is an optional call — `readSessionSlot(...)?.(runId)` — so the
 *    surviving session's background runs then reported no progress at all, with
 *    nothing logged and nothing thrown.
 *
 * Both failure modes are silent, which is why they are tested directly rather
 * than left to the integration tests that would only show a wrong answer.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ACTIVE_WORKFLOW_MANAGER,
  BRIDGE_RUN_STARTED,
  clearSessionSlot,
  clearSlot,
  CONTRACT_SLOT_KEYS,
  CURRENT_TURN,
  isSessionKeyedSlot,
  isSlotPublished,
  publishSessionWorkflowManager,
  readSessionSlot,
  readSessionWorkflowManager,
  SESSION_KEYED_SLOT_KEYS,
  WIKI_SESSION_REPOS,
  writeSessionSlot,
  type BridgeRunNotifier,
  type WorkflowManagerLike,
} from "./extension-contract.ts";

const SESSION_A = "pi-session-a";
const SESSION_B = "pi-session-b";

const makeManager = (runId: string): WorkflowManagerLike => ({
  startInBackground: () => ({ runId }),
});

afterEach(() => {
  for (const key of CONTRACT_SLOT_KEYS) clearSlot(key);
});

describe("the session-keyed slot family", () => {
  it("covers every slot whose value belongs to one session", () => {
    // A new session-scoped slot added as a bare value is the bug this file
    // exists for, so the membership list is asserted rather than assumed.
    expect([...SESSION_KEYED_SLOT_KEYS]).toEqual([
      ACTIVE_WORKFLOW_MANAGER,
      BRIDGE_RUN_STARTED,
      WIKI_SESSION_REPOS,
      CURRENT_TURN,
    ]);
    for (const key of SESSION_KEYED_SLOT_KEYS) {
      expect(isSessionKeyedSlot(key)).toBe(true);
    }
  });
});

describe("the workflow manager slot", () => {
  it("hands each session its own manager", () => {
    const managerA = makeManager("run-a");
    const managerB = makeManager("run-b");

    publishSessionWorkflowManager(SESSION_A, managerA);
    publishSessionWorkflowManager(SESSION_B, managerB);

    // Before keying, B's session_start replaced A's manager outright, and A's
    // next wiki ingest started its coordinator run on B's manager.
    expect(readSessionWorkflowManager(SESSION_A)).toBe(managerA);
    expect(readSessionWorkflowManager(SESSION_B)).toBe(managerB);
  });

  it("reports no manager for a session that never published one", () => {
    publishSessionWorkflowManager(SESSION_A, makeManager("run-a"));
    expect(readSessionWorkflowManager(SESSION_B)).toBeUndefined();
  });

  it("verifies the load report against this session, not any session", () => {
    const managerB = makeManager("run-b");
    publishSessionWorkflowManager(SESSION_B, managerB);

    // The manifest declares this slot as workflow's `providesSlots`. A's
    // session must not pass verification on B's entry — that would be the
    // "loaded but published nothing" failure going unreported.
    expect(isSlotPublished(ACTIVE_WORKFLOW_MANAGER, SESSION_A)).toBe(false);
    expect(isSlotPublished(ACTIVE_WORKFLOW_MANAGER, SESSION_B)).toBe(true);
  });

  it("treats a collected manager as absent", () => {
    // The entry is a WeakRef, so a manager whose extension is gone must read as
    // missing rather than as a live manager that throws on first use. Faked
    // rather than waiting on the collector, which no test can force.
    const dead = new WeakRef({} as WorkflowManagerLike);
    vi.spyOn(dead, "deref").mockReturnValue(undefined);
    writeSessionSlot(ACTIVE_WORKFLOW_MANAGER, SESSION_A, dead);

    expect(readSessionWorkflowManager(SESSION_A)).toBeUndefined();
    expect(isSlotPublished(ACTIVE_WORKFLOW_MANAGER, SESSION_A)).toBe(false);
    // Pruned on read, so a dead ref does not leave a key per session behind.
    expect(readSessionSlot(ACTIVE_WORKFLOW_MANAGER, SESSION_A)).toBeUndefined();
  });
});

describe("the bridge run notifier slot", () => {
  it("routes a run to the session that started it", () => {
    const notifierA = vi.fn<BridgeRunNotifier>();
    const notifierB = vi.fn<BridgeRunNotifier>();

    writeSessionSlot(BRIDGE_RUN_STARTED, SESSION_A, notifierA);
    writeSessionSlot(BRIDGE_RUN_STARTED, SESSION_B, notifierB);

    readSessionSlot(BRIDGE_RUN_STARTED, SESSION_A)?.("run-from-a", {
      primary: true,
    });

    expect(notifierA).toHaveBeenCalledWith("run-from-a", { primary: true });
    expect(notifierB).not.toHaveBeenCalled();
  });

  it("leaves a concurrent session's notifier in place when a turn ends", () => {
    const notifierA = vi.fn<BridgeRunNotifier>();
    const notifierB = vi.fn<BridgeRunNotifier>();

    writeSessionSlot(BRIDGE_RUN_STARTED, SESSION_A, notifierA);
    writeSessionSlot(BRIDGE_RUN_STARTED, SESSION_B, notifierB);

    // B's turn ends first. Before this was keyed, the clear took the whole slot
    // and A spent the rest of its turn announcing runs to nobody.
    clearSessionSlot(BRIDGE_RUN_STARTED, SESSION_B, notifierB);

    expect(readSessionSlot(BRIDGE_RUN_STARTED, SESSION_B)).toBeUndefined();
    readSessionSlot(BRIDGE_RUN_STARTED, SESSION_A)?.("run-from-a");
    expect(notifierA).toHaveBeenCalledWith("run-from-a");
  });

  it("will not let a superseded turn clear the notifier that replaced it", () => {
    const superseded = vi.fn<BridgeRunNotifier>();
    const current = vi.fn<BridgeRunNotifier>();

    // One session, two turns: the second took the turn slot and republished.
    writeSessionSlot(BRIDGE_RUN_STARTED, SESSION_A, superseded);
    writeSessionSlot(BRIDGE_RUN_STARTED, SESSION_A, current);

    // The first turn's `finally` now runs. Identity-guarded, so it is a no-op —
    // the same guard, and the same reason, as TurnSlot.finish().
    clearSessionSlot(BRIDGE_RUN_STARTED, SESSION_A, superseded);

    readSessionSlot(BRIDGE_RUN_STARTED, SESSION_A)?.("run-from-current-turn");
    expect(current).toHaveBeenCalledWith("run-from-current-turn");
    expect(superseded).not.toHaveBeenCalled();
  });

  it("clears unconditionally when no expected value is given", () => {
    const notifier = vi.fn<BridgeRunNotifier>();
    writeSessionSlot(BRIDGE_RUN_STARTED, SESSION_A, notifier);

    clearSessionSlot(BRIDGE_RUN_STARTED, SESSION_A);

    expect(readSessionSlot(BRIDGE_RUN_STARTED, SESSION_A)).toBeUndefined();
  });
});

describe("a caller with no session id", () => {
  it("publishes nothing rather than filing under a shared key", () => {
    // The pre-keying failure was precisely a value every session could read.
    // Silent, matching setSessionRepos: the slot only exists to be reached by
    // session, and there is no one for an unkeyed value to reach.
    publishSessionWorkflowManager(undefined, makeManager("run-x"));
    writeSessionSlot(BRIDGE_RUN_STARTED, undefined, vi.fn<BridgeRunNotifier>());

    expect(readSessionWorkflowManager(undefined)).toBeUndefined();
    expect(readSessionWorkflowManager(SESSION_A)).toBeUndefined();
    expect(readSessionSlot(BRIDGE_RUN_STARTED, SESSION_A)).toBeUndefined();
  });

  it("verifies a slot as 'published by anyone', the unkeyed question", () => {
    // What a caller that has not bound a session can still meaningfully ask,
    // and what the check meant before the slots were keyed.
    expect(isSlotPublished(ACTIVE_WORKFLOW_MANAGER)).toBe(false);

    const manager = makeManager("run-a");
    publishSessionWorkflowManager(SESSION_A, manager);

    expect(isSlotPublished(ACTIVE_WORKFLOW_MANAGER)).toBe(true);
    expect(isSlotPublished(BRIDGE_RUN_STARTED)).toBe(false);
  });
});

describe("session repos, the slot that was already keyed", () => {
  it("reads through the same helpers as the other two", () => {
    // wiki-session-repo.ts writes this through the "@/" alias and the bridge
    // reads it through jiti; the shared helpers are what keep the two agreeing.
    writeSessionSlot(WIKI_SESSION_REPOS, SESSION_A, ["repo-a"]);
    writeSessionSlot(WIKI_SESSION_REPOS, SESSION_B, ["repo-b"]);

    expect(readSessionSlot(WIKI_SESSION_REPOS, SESSION_A)).toEqual(["repo-a"]);
    expect(readSessionSlot(WIKI_SESSION_REPOS, SESSION_B)).toEqual(["repo-b"]);
  });
});

describe("the current-turn slot", () => {
  it("hands each session its own turn without overwriting the other's", () => {
    const turnA = { startedAt: "2026-01-01T00:00:00.000Z", turnId: "turn-a" };
    const turnB = { startedAt: "2026-01-01T00:00:01.000Z", turnId: "turn-b" };

    writeSessionSlot(CURRENT_TURN, SESSION_A, turnA);
    writeSessionSlot(CURRENT_TURN, SESSION_B, turnB);

    expect(readSessionSlot(CURRENT_TURN, SESSION_A)).toEqual(turnA);
    expect(readSessionSlot(CURRENT_TURN, SESSION_B)).toEqual(turnB);
  });

  it("does not let a superseding turn's entry be cleared by the one it replaced", () => {
    const first = { startedAt: "2026-01-01T00:00:00.000Z", turnId: "turn-1" };
    const second = { startedAt: "2026-01-01T00:00:05.000Z", turnId: "turn-2" };

    writeSessionSlot(CURRENT_TURN, SESSION_A, first);
    writeSessionSlot(CURRENT_TURN, SESSION_A, second);

    // The first turn's `finally` runs after the second has already taken the
    // slot. Identity-guarded, so this must be a no-op.
    clearSessionSlot(CURRENT_TURN, SESSION_A, first);

    expect(readSessionSlot(CURRENT_TURN, SESSION_A)).toEqual(second);
  });

  it("clears cleanly when the identity matches", () => {
    const turn = { startedAt: "2026-01-01T00:00:00.000Z", turnId: "turn-1" };
    writeSessionSlot(CURRENT_TURN, SESSION_A, turn);
    clearSessionSlot(CURRENT_TURN, SESSION_A, turn);
    expect(readSessionSlot(CURRENT_TURN, SESSION_A)).toBeUndefined();
  });
});
