/**
 * A wiki ingest is dispatched straight into the manager rather than started by
 * the agent calling the `workflow` tool, so the session's tool-execution
 * listeners never saw it. Across 72 recorded runs not one synthesis workflow
 * was written to .semla-debug — the one part of an orient that could not be
 * inspected afterwards.
 */
import { describe, expect, it, vi } from "vitest";

import { followBridgeRunProgress } from "./bridge-run-progress.ts";

type Listener = (payload: unknown) => void;

function fakeManager(snapshot: unknown = { runId: "run-1", agentCount: 2 }) {
  const listeners = new Map<string, Set<Listener>>();
  return {
    startInBackground: () => ({ runId: "run-1" }),
    on(event: string, listener: Listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
    },
    off(event: string, listener: Listener) {
      listeners.get(event)?.delete(listener);
    },
    getSnapshot: (runId: string) => (runId === "run-1" ? snapshot : null),
    emit(event: string, payload: unknown) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(payload);
    },
    count: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
  };
}

describe("followBridgeRunProgress", () => {
  it("emits a snapshot for each progress event", () => {
    const manager = fakeManager();
    const emit = vi.fn();
    followBridgeRunProgress(manager, "run-1", emit);

    manager.emit("agentStart", { runId: "run-1" });
    manager.emit("agentEnd", { runId: "run-1" });

    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith({ runId: "run-1", agentCount: 2 });
  });

  it("ignores another run sharing the manager", () => {
    const manager = fakeManager();
    const emit = vi.fn();
    followBridgeRunProgress(manager, "run-1", emit);

    manager.emit("agentStart", { runId: "run-2" });

    expect(emit).not.toHaveBeenCalled();
  });

  it("emits a final snapshot and then unsubscribes", () => {
    const manager = fakeManager();
    const emit = vi.fn();
    followBridgeRunProgress(manager, "run-1", emit);
    expect(manager.count()).toBeGreaterThan(0);

    manager.emit("complete", { runId: "run-1" });

    expect(emit).toHaveBeenCalledTimes(1);
    expect(manager.count()).toBe(0);

    manager.emit("agentStart", { runId: "run-1" });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("releases on error too, so a failed run leaks no listener", () => {
    const manager = fakeManager();
    followBridgeRunProgress(manager, "run-1", vi.fn());

    manager.emit("error", { runId: "run-1" });

    expect(manager.count()).toBe(0);
  });

  it("does nothing when the manager cannot report progress", () => {
    const emit = vi.fn();
    const dispose = followBridgeRunProgress(
      { startInBackground: () => ({ runId: "run-1" }) },
      "run-1",
      emit,
    );

    expect(emit).not.toHaveBeenCalled();
    expect(() => dispose()).not.toThrow();
  });

  it("skips an event whose snapshot is not available yet", () => {
    const manager = fakeManager(null);
    const emit = vi.fn();
    followBridgeRunProgress(manager, "run-1", emit);

    manager.emit("phase", { runId: "run-1" });

    expect(emit).not.toHaveBeenCalled();
  });
});
