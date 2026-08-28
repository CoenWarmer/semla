import { join } from "node:path";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const hostDevelopmentEnabled =
  process.env.NODE_ENV === "development" &&
  process.env.PI_ALLOW_HOST_DEV === "true";

// The wiki extension's pi.extensions field declares "./extensions" (a directory
// with no index.ts at its root), so the package manager resolves it to a path
// jiti cannot import. Load the actual entry point directly instead, bypassing
// the package's pi.extensions declaration entirely.
export const WIKI_EXTENSION_PATH = join(
  process.cwd(),
  ".pi/npm/node_modules/@zosmaai/pi-llm-wiki/extensions/llm-wiki/index.ts",
);

// Bridge that intercepts wiki_ingest background synthesis and runs it as Semla
// dynamic workflows so each source appears in the trace waterfall. Must load
// AFTER both the workflow extension and the wiki extension.
export const WIKI_INGEST_BRIDGE_PATH = join(
  process.cwd(),
  "src/lib/pi/extensions/wiki-ingest-bridge.ts",
);

// Semla's own extensions. Anchored to the server's cwd like the wiki paths
// above: PI_WORKSPACE_ROOT is the repo the agent operates *on*, not the repo
// these files live in.
export const WORKFLOW_EXTENSION_PATH = join(
  process.cwd(),
  "src/lib/pi/extensions/workflow.ts",
);

export const ASK_USER_EXTENSION_PATH = join(
  process.cwd(),
  "src/lib/pi/extensions/ask-user.ts",
);

// The workflow skills ship inside the dynamic-workflows package but are only
// contributed when it is loaded as a package. Sessions load the extension file
// directly, so the skills are pointed at explicitly rather than inherited from
// whatever is installed in the developer's agent dir.
export const WORKFLOW_SKILLS_PATH = join(
  process.cwd(),
  "src/lib/pi/extensions/dynamic-workflows/skills",
);

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
