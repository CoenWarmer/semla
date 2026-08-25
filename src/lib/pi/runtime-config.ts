import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const hostDevelopmentEnabled =
  process.env.NODE_ENV === "development" &&
  process.env.PI_ALLOW_HOST_DEV === "true";

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
