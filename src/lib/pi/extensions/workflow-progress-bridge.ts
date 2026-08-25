/**
 * Semla bridge extension: the globalThis registry (Symbol.for("semla.workflow.managers"))
 * is now populated directly inside WorkflowManager.startInBackground in the forked
 * packages/pi-dynamic-workflows. This file is kept as a registered extension entry point
 * but no longer needs to do any prototype patching.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export default function workflowProgressBridge(_api: ExtensionAPI) {
  // Registration is handled inside WorkflowManager.startInBackground.
}
