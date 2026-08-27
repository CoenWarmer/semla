import { join } from "node:path";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const hostDevelopmentEnabled =
  process.env.NODE_ENV === "development" &&
  process.env.PI_ALLOW_HOST_DEV === "true";

// WIKI_HOME controls where pi-llm-wiki's personal vault lives. Defaulting it
// to a Semla-owned directory keeps wiki files out of the repos being worked in
// and out of the user's home dir. Exposed so the agent's bash tool can resolve
// the path (e.g. to check if a wiki has been initialised for a repo).
export const WIKI_HOME = (() => {
  const dir = process.env.WIKI_HOME ?? join(process.cwd(), ".semla-wiki");
  process.env.WIKI_HOME = dir;
  return dir;
})();

export const PI_WORKSPACE_ROOT = process.env.PI_WORKSPACE_ROOT
  ?? (hostDevelopmentEnabled ? process.cwd() : "/workspace");
export const PI_SESSION_DIR = "/tmp/semla-pi-sessions";

// Resource discovery dir for Semla's Pi sessions, deliberately NOT the
// developer's ~/.pi/agent. Sharing it made every session inherit whatever
// packages that machine happened to have installed: the workflow extension was
// listed there as a user package, so it loaded twice per prompt (once from this
// repo's pinned node_modules, once from ~/.pi/agent/npm) and the second copy
// failed with a tool-name conflict. An empty, Semla-owned dir keeps the
// extension set reproducible and identical to the container. Project-scope
// packages still load: those come from <workspace>/.pi/settings.json, keyed to
// cwd rather than to this dir. Model credentials and the model catalog are
// unaffected — ModelRuntime resolves those from ~/.pi/agent independently.
// Set PI_AGENT_DIR to restore the previous shared-dir behaviour.
export const PI_AGENT_DIR = process.env.PI_AGENT_DIR ?? "/tmp/semla-pi-agent";
export const PI_TOOLS = [
  "read",
  "bash",
  "edit",
  "write",
  "workflow",
  "workflow_control",
  "ask_user",
] as const;

export const getPiRuntimeConfig = () => ({
  apiKeyConfigured: Boolean(process.env.PI_MODEL_API_KEY),
  hostDevelopmentEnabled,
  sandboxed: process.env.PI_SANDBOXED === "true",
  sessionDirectory: PI_SESSION_DIR,
  tools: PI_TOOLS,
  workspaceRoot: PI_WORKSPACE_ROOT,
});

export const getPiCredentialProviders = async (): Promise<string[]> => {
  try {
    const runtime = await ModelRuntime.create({ refreshOnCreate: false });
    const credentials = await runtime.listCredentials();

    return credentials
      .map((credential) => credential.providerId)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
};
