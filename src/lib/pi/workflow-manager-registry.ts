import type { WorkflowManager } from "@quintinshaw/pi-dynamic-workflows";

// Shared key between this module and the bridge extension, which runs in a
// different module scope (loaded by pi-coding-agent via import()). Symbol.for
// ensures both sides refer to the exact same slot in globalThis.
const REGISTRY_KEY = Symbol.for("semla.workflow.managers");
const g = globalThis as Record<symbol, Map<string, WeakRef<WorkflowManager>> | undefined>;

const registry = (): Map<string, WeakRef<WorkflowManager>> => {
  g[REGISTRY_KEY] ??= new Map();
  return g[REGISTRY_KEY]!;
};

export const getActiveManager = (runId: string): WorkflowManager | null => {
  const ref = registry().get(runId);
  const manager = ref?.deref() ?? null;
  if (!manager) {
    registry().delete(runId);
    return null;
  }
  return manager;
};
