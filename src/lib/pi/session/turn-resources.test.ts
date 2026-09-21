/**
 * The failure mode this exists to make testable: `runPiPrompt` used to
 * release its six per-turn resources by hand, in an order kept in sync with
 * acquisition only by eye, and reachable only through a live provider and
 * Supabase. These tests exercise the accumulator directly, with fakes for the
 * disposers — no session, no provider, no database.
 */
import { describe, expect, it, vi } from "vitest";

import { TurnResources } from "./turn-resources.ts";

describe("TurnResources", () => {
  it("releases nothing when nothing was pushed", () => {
    const resources = new TurnResources();

    expect(() => resources.release()).not.toThrow();
  });

  it("releases the one resource it holds", () => {
    const dispose = vi.fn();
    const resources = new TurnResources();
    resources.push(dispose);

    resources.release();

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  // The order this exists to preserve: runPiPrompt's tightly-scoped cluster
  // acquires wiki repo, span sink, ask-user notifier, feature-spec notifier,
  // live-session, then the event subscription — in that order — and releases
  // in exact reverse today. BRIDGE_RUN_STARTED and CURRENT_TURN are not part
  // of this cluster: they release later, after the turn's span flush, which
  // is exactly why they are not pushed here.
  it("releases in the exact reverse of acquisition order", () => {
    const order: string[] = [];
    const resources = new TurnResources();
    resources.push(() => order.push("wiki-repo"));
    resources.push(() => order.push("span-sink"));
    resources.push(() => order.push("ask-user-notifier"));
    resources.push(() => order.push("feature-spec-notifier"));
    resources.push(() => order.push("live-session"));
    resources.push(() => order.push("subscription"));

    resources.release();

    expect(order).toEqual([
      "subscription",
      "live-session",
      "feature-spec-notifier",
      "ask-user-notifier",
      "span-sink",
      "wiki-repo",
    ]);
  });

  // A turn can throw before it finishes acquiring all eight — e.g. before the
  // event subscription, which is the last of the eight taken. Only what was
  // actually pushed should be released; there is nothing else to release.
  it("releases only what was actually acquired before a partial failure", () => {
    const disposeA = vi.fn();
    const disposeB = vi.fn();
    const resources = new TurnResources();
    resources.push(disposeA);
    resources.push(disposeB);
    // A third resource's acquisition is never reached — the turn throws first
    // and never calls `resources.push` for it.

    resources.release();

    expect(disposeA).toHaveBeenCalledTimes(1);
    expect(disposeB).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: a second release call releases nothing", () => {
    const dispose = vi.fn();
    const resources = new TurnResources();
    resources.push(dispose);

    resources.release();
    resources.release();

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("keeps a disposer's own identity guard intact", () => {
    // Mirrors releaseLiveSession's shape: the disposer closes over the exact
    // value that was published, so a superseded turn's disposer would be a
    // no-op against a newer registration — but that guard lives inside the
    // closure passed to push, not in TurnResources itself.
    const registry = new Map<string, symbol>();
    const key = "s1";
    const handle = Symbol("session");
    registry.set(key, handle);

    const resources = new TurnResources();
    resources.push(() => {
      if (registry.get(key) === handle) registry.delete(key);
    });

    // Superseded before release: a newer turn's handle displaces this one.
    const newer = Symbol("newer-session");
    registry.set(key, newer);

    resources.release();

    expect(registry.get(key)).toBe(newer);
  });
});
