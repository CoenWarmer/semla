// Minimal interface — we only call getSnapshot() on the manager.
interface WorkflowManagerLike {
  getSnapshot(runId: string): unknown;
}

// Shared key between this module and the workflow manager (packages/pi-dynamic-workflows),
// which runs in a different module scope (loaded by pi-coding-agent via import()). Symbol.for
// ensures both sides refer to the exact same slot in globalThis.
const REGISTRY_KEY = Symbol.for("semla.workflow.managers");
const g = globalThis as Record<symbol, Map<string, WeakRef<WorkflowManagerLike>> | undefined>;

const registry = (): Map<string, WeakRef<WorkflowManagerLike>> => {
  g[REGISTRY_KEY] ??= new Map();
  return g[REGISTRY_KEY]!;
};

export const getActiveManager = (runId: string): WorkflowManagerLike | null => {
  const ref = registry().get(runId);
  const manager = ref?.deref() ?? null;
  if (!manager) {
    registry().delete(runId);
    return null;
  }
  return manager;
};
