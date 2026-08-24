/**
 * Semla bridge extension: patches WorkflowManager.startInBackground so that
 * every background run's manager reference is stored in a globalThis registry.
 * This lets the snapshot API (workflow-service.ts) read live in-memory agent
 * state (including running/queued agents) rather than relying solely on the
 * disk file, which only updates when agents complete.
 *
 * Uses Symbol.for to share the registry with workflow-manager-registry.ts
 * across module contexts (pi-coding-agent loads extensions via import()).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WorkflowManager } from "@quintinshaw/pi-dynamic-workflows";

const REGISTRY_KEY = Symbol.for("semla.workflow.managers");
const PATCHED_KEY = Symbol.for("semla.workflow.patched");
const g = globalThis as Record<symbol, unknown>;

g[REGISTRY_KEY] ??= new Map<string, WeakRef<WorkflowManager>>();

if (!g[PATCHED_KEY]) {
  g[PATCHED_KEY] = true;
  const orig = WorkflowManager.prototype.startInBackground;
  WorkflowManager.prototype.startInBackground = function (
    this: WorkflowManager,
    ...args: Parameters<typeof WorkflowManager.prototype.startInBackground>
  ) {
    const result = orig.apply(this, args);
    if (result?.runId) {
      (g[REGISTRY_KEY] as Map<string, WeakRef<WorkflowManager>>).set(
        result.runId,
        new WeakRef(this),
      );
    }
    return result;
  };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export default function workflowProgressBridge(_api: ExtensionAPI) {
  // All work is done at module-load time above; no per-session handlers needed.
}
