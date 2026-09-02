import type { WorkflowManagerLike } from "@/lib/pi/extension-contract";

/**
 * Events a run emits as it progresses. `complete` and `error` are handled
 * separately because they also end the subscription.
 */
export const BRIDGE_PROGRESS_EVENTS = [
  "agentStart",
  "agentEnd",
  "agentHistory",
  "phase",
  "log",
  "tokenUsage",
  "paused",
] as const;

/**
 * Mirror a bridge-dispatched run's progress into the host's snapshot sinks.
 *
 * A session's own listeners key on `tool_execution_update` for the `workflow`
 * tool, which only fires for runs the agent started by calling that tool. A
 * wiki ingest is started programmatically by the bridge, so it emitted no
 * snapshots at all: across 72 recorded runs not one synthesis workflow reached
 * .semla-debug and none appeared in the trace waterfall — while the tool still
 * reported "Ingesting via Semla workflows". Synthesis was the one part of an
 * orient nobody could inspect afterwards.
 *
 * Returns a disposer; the subscription also releases itself when the run ends.
 */
export function followBridgeRunProgress(
  manager: WorkflowManagerLike | undefined,
  runId: string,
  emitSnapshot: (snapshot: unknown) => void,
): () => void {
  // Extracted to guard on its presence before subscribing; `this` is restored
  // by the .call(manager) in `forward` below.
  // oxlint-disable-next-line typescript/unbound-method
  const getSnapshot = manager?.getSnapshot;
  if (!manager?.on || !getSnapshot) return () => {};

  let released = false;

  const forward = (payload: unknown) => {
    // Every run on this manager emits through the same listener, so the runId
    // on the payload is what makes this one run's progress its own.
    if ((payload as { runId?: string } | null)?.runId !== runId) return;
    const snapshot = getSnapshot.call(manager, runId);
    if (snapshot) emitSnapshot(snapshot);
  };

  const release = () => {
    if (released) return;
    released = true;
    for (const event of BRIDGE_PROGRESS_EVENTS) manager.off?.(event, forward);
    manager.off?.("complete", settle);
    manager.off?.("error", settle);
  };

  // Named rather than inline so `release` can unsubscribe it by reference.
  function settle(payload: unknown) {
    if ((payload as { runId?: string } | null)?.runId !== runId) return;
    forward(payload);
    release();
  }

  for (const event of BRIDGE_PROGRESS_EVENTS) manager.on(event, forward);
  manager.on("complete", settle);
  manager.on("error", settle);

  return release;
}
