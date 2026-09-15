/**
 * The rendezvous is the mechanism two tools now share, so a regression here
 * breaks `ask_user` and `capture_feature_spec` together.
 *
 * What these pin is the behaviour that was duplicated in the two bridges this
 * replaced — per-session isolation, the abort path, and the identity guards —
 * because a shared mechanism is only an improvement if it is the *correct* copy
 * of the two.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ASK_USER_RENDEZVOUS,
  clearSlot,
  FEATURE_SPEC_RENDEZVOUS,
} from "../extension-loading/extension-contract.ts";
import { createSessionRendezvous } from "./session-rendezvous.ts";

type Request = { question: string };
type Response = { answer: string };

const make = () =>
  createSessionRendezvous<Request, Response>({
    slot: ASK_USER_RENDEZVOUS,
    toolName: "ask_user",
  });

afterEach(() => {
  clearSlot(ASK_USER_RENDEZVOUS);
  clearSlot(FEATURE_SPEC_RENDEZVOUS);
});

describe("createSessionRendezvous", () => {
  it("carries a request out and a response back", async () => {
    const rendezvous = make();
    const notify = vi.fn();
    rendezvous.registerNotifier("session-a", notify);

    const pending = rendezvous.waitFor("session-a", { question: "which?" });

    expect(notify).toHaveBeenCalledWith({ question: "which?" });
    expect(rendezvous.deliver("session-a", { answer: "this one" })).toBe(true);
    await expect(pending).resolves.toEqual({ answer: "this one" });
  });

  it("rejects when the session has no notifier", async () => {
    const rendezvous = make();
    await expect(
      rendezvous.waitFor("never-started", { question: "which?" }),
    ).rejects.toThrow("ask_user: no active session for never-started");
  });

  it("reports nothing waiting rather than throwing", () => {
    const rendezvous = make();
    rendezvous.registerNotifier("session-a", vi.fn());
    expect(rendezvous.deliver("session-a", { answer: "unasked" })).toBe(false);
  });

  /**
   * The failure the session keying prevents: with one process-wide pending
   * slot, B's answer settles A's tool call and A's user sees their question
   * answered by someone else's input.
   */
  it("keeps concurrent sessions apart", async () => {
    const rendezvous = make();
    const notifyA = vi.fn();
    const notifyB = vi.fn();
    rendezvous.registerNotifier("session-a", notifyA);
    rendezvous.registerNotifier("session-b", notifyB);

    const pendingA = rendezvous.waitFor("session-a", { question: "for A" });
    const pendingB = rendezvous.waitFor("session-b", { question: "for B" });

    expect(notifyA).toHaveBeenCalledWith({ question: "for A" });
    expect(notifyB).toHaveBeenCalledWith({ question: "for B" });

    rendezvous.deliver("session-b", { answer: "B's answer" });
    await expect(pendingB).resolves.toEqual({ answer: "B's answer" });

    rendezvous.deliver("session-a", { answer: "A's answer" });
    await expect(pendingA).resolves.toEqual({ answer: "A's answer" });
  });

  it("rejects an already-aborted signal without notifying", async () => {
    const rendezvous = make();
    const notify = vi.fn();
    rendezvous.registerNotifier("session-a", notify);

    const pending = rendezvous.waitFor(
      "session-a",
      { question: "which?" },
      AbortSignal.abort(),
    );

    await expect(pending).rejects.toThrow("ask_user cancelled");
    expect(notify).not.toHaveBeenCalled();
  });

  it("rejects on a later abort and stops accepting a delivery", async () => {
    const rendezvous = make();
    rendezvous.registerNotifier("session-a", vi.fn());
    const controller = new AbortController();

    const pending = rendezvous.waitFor(
      "session-a",
      { question: "which?" },
      controller.signal,
    );
    controller.abort();

    await expect(pending).rejects.toThrow("ask_user cancelled");
    expect(rendezvous.deliver("session-a", { answer: "too late" })).toBe(false);
  });

  /**
   * Two things at once, and both used to be wrong. The displaced call has to
   * settle — overwriting the map entry left it pending forever inside a tool's
   * execute() — and the abort on its now-stale signal must not cancel the call
   * that replaced it.
   */
  it("settles a displaced call without letting its abort hit the replacement", async () => {
    const rendezvous = make();
    rendezvous.registerNotifier("session-a", vi.fn());
    const controller = new AbortController();

    const first = rendezvous.waitFor(
      "session-a",
      { question: "first" },
      controller.signal,
    );
    const second = rendezvous.waitFor("session-a", { question: "second" });

    await expect(first).rejects.toThrow(
      "ask_user: superseded by a newer request",
    );

    controller.abort();

    expect(rendezvous.deliver("session-a", { answer: "for second" })).toBe(true);
    await expect(second).resolves.toEqual({ answer: "for second" });
  });

  it("identity-guards unregister so a stale turn cannot unhook a live one", () => {
    const rendezvous = make();
    const stale = vi.fn();
    const live = vi.fn();

    const unregisterStale = rendezvous.registerNotifier("session-a", stale);
    rendezvous.registerNotifier("session-a", live);
    unregisterStale();

    void rendezvous.waitFor("session-a", { question: "which?" }).catch(() => {});
    expect(live).toHaveBeenCalledWith({ question: "which?" });
    expect(stale).not.toHaveBeenCalled();
  });

  it("gives each slot its own state", async () => {
    const askUser = make();
    const featureSpec = createSessionRendezvous<void, Response>({
      slot: FEATURE_SPEC_RENDEZVOUS,
      toolName: "capture_feature_spec",
    });

    askUser.registerNotifier("session-a", vi.fn());

    // Same session id, different tool: the ask_user notifier must not answer
    // for capture_feature_spec.
    await expect(featureSpec.waitFor("session-a", undefined)).rejects.toThrow(
      "capture_feature_spec: no active session for session-a",
    );
  });

  /**
   * Two instances over one slot are what the process actually has when the
   * tool side and the route side load this module separately — the reason the
   * state sits in a globalThis slot rather than a module-level Map.
   */
  it("shares state between separate instances over the same slot", async () => {
    const toolSide = make();
    const routeSide = make();

    toolSide.registerNotifier("session-a", vi.fn());
    const pending = toolSide.waitFor("session-a", { question: "which?" });

    expect(routeSide.deliver("session-a", { answer: "from the route" })).toBe(
      true,
    );
    await expect(pending).resolves.toEqual({ answer: "from the route" });
  });
});
