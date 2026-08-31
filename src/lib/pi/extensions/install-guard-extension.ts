/**
 * Refuses bash commands that would install something, so the agent has to ask.
 *
 * Registered as its own extension rather than folded into another: it is the
 * only thing here that can stop a tool call, and burying that in the wiki
 * bridge would make it invisible to anyone reading the manifest.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { inspectCommand } from "./install-guard.js";

// Read from the environment rather than runtime-config: this file is loaded by
// jiti, which does not resolve the "@/" alias.
const WIKI_HOME = process.env.WIKI_HOME ?? join(process.cwd(), ".semla-wiki");

/**
 * Whether an npx target already exists locally.
 *
 * Checked in Semla's own node_modules and in the workspace the agent runs in,
 * because the tools it uses constantly (tsc, vitest, eslint) live in the first
 * and a repo it is working on may have its own in the second. A binary present
 * in neither is one npx would fetch.
 */
const binaryExists = (name: string): boolean => {
  const roots = [process.cwd(), process.env.PI_WORKSPACE_ROOT].filter(
    (root): root is string => Boolean(root),
  );
  return roots.some((root) => existsSync(join(root, "node_modules", ".bin", name)));
};

export default function installGuard(pi: ExtensionAPI) {
  pi.on("tool_call", (event: unknown) => {
    const call = event as { toolName?: string; input?: { command?: unknown } };
    if (call.toolName !== "bash") return undefined;

    const command = call.input?.command;
    if (typeof command !== "string") return undefined;

    const verdict = inspectCommand(command, binaryExists, WIKI_HOME);
    if (!verdict.blocked) return undefined;

    console.warn(`[install-guard] blocked: ${command}`);
    return { block: true, reason: verdict.reason };
  });
}
