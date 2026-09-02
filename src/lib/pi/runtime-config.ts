import { join } from "node:path";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const hostDevelopmentEnabled =
  process.env.NODE_ENV === "development" &&
  process.env.PI_ALLOW_HOST_DEV === "true";

/**
 * @zosmaai/pi-llm-wiki, in this repository's own node_modules.
 *
 * It used to live in `.pi/npm`: a second dependency tree, with its own
 * lockfile, that existed for this one package — and that `npm audit` only ever
 * saw when run there. What it hid was two high-severity advisories against a
 * *second* agent runtime, 0.73.1, which the package's
 * `peerDependencies: { "@mariozechner/pi-coding-agent": "*" }` pulled in
 * against a scope pi has since been renamed away from.
 *
 * Two `overrides` in package.json alias that peer, and its TUI sibling, onto
 * the packages this repository already pins, so the wildcard resolves to
 * 0.84.2 and the tree is gone. Only two of the package's eighteen imports of
 * it are values rather than types — `getAgentDir` and `isToolCallEventType` —
 * and both exist on the renamed package.
 *
 * Every path into the package derives from here, because there were six of
 * them spelled out in three files when this moved.
 */
export const WIKI_PACKAGE_DIR = join(
  process.cwd(),
  "node_modules/@zosmaai/pi-llm-wiki",
);

// The wiki extension's pi.extensions field declares "./extensions" (a directory
// with no index.ts at its root), so the package manager resolves it to a path
// jiti cannot import. Load the actual entry point directly instead, bypassing
// the package's pi.extensions declaration entirely.
//
// The *sources*, not dist: that is what `patches/` patches, and the dispatcher
// hook wiki-ingest-bridge.ts depends on exists only there.
export const WIKI_EXTENSION_PATH = join(
  WIKI_PACKAGE_DIR,
  "extensions/llm-wiki/index.ts",
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

// Code intelligence: LSP- and tree-sitter-backed navigation. Declared in this
// repository's package.json and loaded from root node_modules by path, not
// through pi's package resolution out of .pi/npm — see the extension-dependency
// decision in AGENTS.md.
//
// The *headless* profile deliberately, not the full interactive one. It
// registers six inspection tools and needs nothing but registerTool and on,
// where the interactive profile also contributes settings, a footer, a slash
// command and two refactor tools that can apply edits. Semla renders none of
// that UI, and an agent that can rewrite files behind a code-navigation tool is
// not what this is here for.
export const CODE_INTELLIGENCE_EXTENSION_PATH = join(
  process.cwd(),
  "node_modules/@mrclrchtr/supi-code-intelligence/src/headless.ts",
);

// Resolves a call graph with the TypeScript checker and draws it in the session
// panel. Registered here rather than taken from a package because owning the
// tool is what keeps the structured map intact through the tool result.
export const CODE_MAP_EXTENSION_PATH = join(
  process.cwd(),
  "src/lib/pi/extensions/code-map.ts",
);

// Refuses bash commands that would install a package. Loaded like the others
// rather than bundled into one, so the manifest shows what can block a call.
export const INSTALL_GUARD_EXTENSION_PATH = join(
  process.cwd(),
  "src/lib/pi/extensions/install-guard-extension.ts",
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
/**
 * Pi session transcripts, one .jsonl per Semla session.
 *
 * Kept inside the Semla directory rather than /tmp, which is wiped on reboot:
 * these files are the on-disk record of every conversation, and Semla is a
 * single-machine tool, so containment beats a system temp dir. Gitignored —
 * they hold whatever was discussed.
 */
/**
 * How often Semla may `git fetch` a project to keep divergence counts honest.
 *
 * Reading refs alone reports where you stood at the last fetch, which drifts
 * quietly: a branch showed "up to date" while 432 commits behind. Fetching is
 * a network call with side effects, though, so it is throttled per repository
 * and never blocks a request. Set to 0 to switch it off entirely — useful on a
 * metered connection, or where a remote needs credentials this process lacks.
 */
export const GIT_FETCH_INTERVAL_MS = Number(
  process.env.SEMLA_GIT_FETCH_INTERVAL_MS ?? 60_000,
);

export const PI_SESSION_DIR =
  process.env.PI_SESSION_DIR ?? join(process.cwd(), ".semla-sessions");

// Resource discovery dir for Semla's Pi sessions, deliberately NOT the
// developer's ~/.pi/agent. Sharing it made every session inherit whatever
// packages that machine happened to have installed: the workflow extension was
// listed there as a user package, so it loaded twice per prompt (once from this
// repo's pinned node_modules, once from ~/.pi/agent/npm) and the second copy
// failed with a tool-name conflict. A Semla-owned dir keeps the extension set
// reproducible and identical to the container. Project-scope packages still
// load: those come from <workspace>/.pi/settings.json, keyed to cwd rather than
// to this dir.
//
// Same directory agent-dir.ts points PI_CODING_AGENT_DIR at, so discovery and
// credentials agree rather than reading from two different places. It holds
// only auth.json and models-store.json — never settings.json or npm/, which is
// what would bring the host's packages back.
export { PI_AGENT_DIR } from "@/lib/pi/agent-dir";
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
