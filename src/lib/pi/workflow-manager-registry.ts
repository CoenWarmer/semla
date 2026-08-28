import {
  readOrInitSlot,
  WORKFLOW_MANAGER_REGISTRY,
  type WorkflowSnapshotSource,
} from "@/lib/pi/extension-contract";

// The workflow manager runs in a different module scope (loaded by
// pi-coding-agent via import()), so the registry lives in a globalThis slot
// declared once in extension-contract.ts and shared by both sides.
const registry = (): Map<string, WeakRef<WorkflowSnapshotSource>> =>
  readOrInitSlot(WORKFLOW_MANAGER_REGISTRY, () => new Map());

export const getActiveManager = (
  runId: string,
): WorkflowSnapshotSource | null => {
  const ref = registry().get(runId);
  const manager = ref?.deref() ?? null;
  if (!manager) {
    registry().delete(runId);
    return null;
  }
  return manager;
};
