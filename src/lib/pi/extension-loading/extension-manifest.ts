/**
 * The declared set of Pi extensions a Semla session loads, and the checks that
 * make loading them a verified operation rather than a hopeful one.
 *
 * Previously this was a bare array of paths passed to DefaultResourceLoader.
 * Three things were implicit in that array and are explicit here:
 *
 *  - **Order.** wiki-ingest-bridge must load after both the workflow extension
 *    (it needs the manager slot) and the wiki extension (it replaces one of its
 *    code paths). That was a comment; now it is `requires`, resolved by a
 *    topological sort, so reordering the manifest cannot break the session.
 *  - **What each extension owes.** `providesTools` / `providesSlots` are checked
 *    against what actually registered. Before, only a missing `workflow` tool
 *    was fatal — a wiki extension that failed to load produced a console
 *    warning and a session that silently had no wiki tools.
 *  - **What the UI advertises.** EXTENSION_TOOLS is derived from the manifest
 *    instead of being a second, hand-maintained copy of the same list.
 */

import { statSync } from "node:fs";

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import {
  ACTIVE_WORKFLOW_MANAGER,
  isSlotPublished,
  slotName,
  WIKI_INGEST_DISPATCHER,
  WIKI_REINDEX_DISPATCHER,
  type ContractSlotKey,
} from "@/lib/pi/extension-loading/extension-contract";
import {
  CODE_INTELLIGENCE_EXTENSION_PATH,
  MCP_EXTENSION_PATH,
  PI_TOOLS,
  WIKI_EXTENSION_PATH,
} from "@/lib/pi/runtime/runtime-config";

// Semla's own extensions, imported rather than pointed at. See ExtensionSource.
import askUserExtension from "@/lib/pi/extensions/ask-user";
import featureSpecExtension from "@/lib/pi/extensions/feature-spec";
import placementPromptExtension from "@/lib/pi/extensions/architecture-awareness/placement-prompt";
import placementToolsExtension from "@/lib/pi/extensions/architecture-awareness/placement-tools";
import specPersistenceExtension from "@/lib/pi/extensions/architecture-awareness/spec-persistence";
import codeMapExtension from "@/lib/pi/extensions/code-map";
import codeSearchExtension from "@/lib/pi/extensions/code-search";
import installGuardExtension from "@/lib/pi/extensions/install-guard-extension";
import jevGateExtension from "@/lib/pi/extensions/jev-gate";
import openReviewExtension from "@/lib/pi/extensions/open-review";
import orientStatusExtension from "@/lib/pi/extensions/orient-status";
import readRouterExtension from "@/lib/pi/extensions/read-router";
import wikiIngestBridgeExtension from "@/lib/pi/extensions/wiki-ingest-bridge";
import workflowExtension from "@/lib/pi/extensions/workflow";

export type ExtensionId =
  | "workflow"
  | "ask-user"
  | "feature-spec"
  | "code-map"
  | "code-search"
  | "open-review"
  | "orient-status"
  | "code-intelligence"
  | "install-guard"
  | "read-router"
  | "jev-gate"
  | "wiki"
  | "wiki-ingest-bridge"
  | "mcp"
  | "placement-prompt"
  | "spec-persistence"
  | "placement-tools";

/**
 * How Pi gets hold of an extension.
 *
 * `factory` is an imported function, handed to Pi as an inline extension. This
 * is what Semla's own extensions use: they are then compiled by the same
 * toolchain as the rest of the app, so tsc and the runtime finally resolve
 * imports the same way, the "@/" alias works, and an edit is picked up by HMR
 * instead of needing the extension cache cleared.
 *
 * `path` is an entry file for Pi's own loader, which compiles it with jiti.
 * Reserved for third-party packages that publish TypeScript source: Node
 * refuses to strip types under node_modules, and bundling them breaks the
 * `import.meta.url` that @mrclrchtr/supi-tree-sitter uses to find its 31
 * grammar files and spawn its worker. jiti transpiles in place, which is
 * precisely why those packages expect it.
 */
export type ExtensionSource =
  | { kind: "factory"; factory: ExtensionFactory }
  | { kind: "path"; path: string };

export type ExtensionSpec = {
  /** Stable identifier, used in `requires` and in diagnostics. */
  id: ExtensionId;
  /** Where the extension comes from. */
  source: ExtensionSource;
  /** Extensions that must be loaded before this one. */
  requires: readonly ExtensionId[];
  /** Tool names this extension must have registered once bound. */
  providesTools: readonly string[];
  /**
   * Tool names this extension registers only when a feature is switched on.
   * Reported for diagnostics, never required — and deliberately kept out of
   * EXTENSION_TOOLS so the UI does not advertise a tool the agent lacks.
   */
  optionalTools: readonly string[];
  /** Contract slots this extension must have published once bound. */
  providesSlots: readonly ContractSlotKey[];
  /**
   * Load this extension only for a session anchored on a project.
   *
   * For an extension whose cost scales with the tree it is pointed at, and
   * whose answers only mean anything inside one project. supi-code-intelligence
   * stands up an LSP workspace over the session's cwd from a `session_start`
   * handler: 519ms for a project, 75 seconds for the workspace root above all
   * fifty of them — paid on every turn, before the model sees the prompt, and
   * not avoidable by deselecting tools, because tool selection happens after
   * binding.
   *
   * Gated on the anchor rather than on the prompt because the extension set has
   * to be decided before the prompt is read. Guessing from the text would mean
   * turns where the agent silently has no code tools and cannot recover — the
   * failure this manifest exists to prevent. The anchor is known up front, and
   * it is the condition under which the tools are useful at all: every one of
   * them is a project-scoped symbol query.
   */
  requiresProjectAnchor?: boolean;
  /** Shown when the extension is missing, so the fix is in the error. */
  remedy: string;
};

/**
 * Wiki tools contributed by @zosmaai/pi-llm-wiki. These are always active
 * regardless of the user's tool selection — session-service re-adds extension
 * tools after setActiveToolsByName.
 */
const WIKI_TOOLS = [
  "wiki_recall",
  "wiki_capture_source",
  "wiki_ingest",
  "wiki_bootstrap",
  "wiki_ensure_page",
  "wiki_search",
  "wiki_lint",
  "wiki_status",
  "wiki_rebuild_meta",
  "wiki_reindex_embeddings",
  "wiki_log_event",
  "wiki_watch",
  "wiki_retro",
] as const;

/**
 * Agent-trajectory tools. pi-llm-wiki gates these behind its
 * `llm-wiki.trajectories` setting, which is opt-in and off by default, so they
 * are normally absent.
 *
 * The hand-maintained list this manifest replaced claimed two of them as
 * always-present (and missed the third entirely), so /api/tools advertised
 * tools the agent did not have. The session smoke test caught it on its first
 * run.
 */
const WIKI_TRAJECTORY_TOOLS = [
  "wiki_capture_trajectory",
  "wiki_distill_skills",
  "wiki_recall_skill",
] as const;

export const EXTENSION_MANIFEST: readonly ExtensionSpec[] = [
  {
    id: "workflow",
    source: { factory: workflowExtension, kind: "factory" },
    requires: [],
    providesTools: ["workflow", "workflow_control"],
    optionalTools: [],
    // Published from the extension's session_start handler, which runs during
    // bindExtensions() — so it is present by the time verification runs.
    providesSlots: [ACTIVE_WORKFLOW_MANAGER],
    remedy:
      "This extension is imported directly; a failure here is a code problem in src/lib/pi/extensions/workflow.ts.",
  },
  {
    id: "ask-user",
    source: { factory: askUserExtension, kind: "factory" },
    requires: [],
    providesTools: ["ask_user"],
    optionalTools: [],
    providesSlots: [],
    remedy:
      "This extension is imported directly; a failure here is a code problem in src/lib/pi/extensions/ask-user.ts.",
  },
  {
    id: "feature-spec",
    source: { factory: featureSpecExtension, kind: "factory" },
    requires: [],
    providesTools: ["capture_feature_spec"],
    optionalTools: [],
    providesSlots: [],
    remedy:
      "This extension is imported directly; a failure here is a code problem in src/lib/pi/extensions/feature-spec.ts.",
  },
  {
    id: "code-map",
    source: { factory: codeMapExtension, kind: "factory" },
    // Reads the project with the TypeScript checker and returns a structured
    // map; depends on nothing else in the session.
    requires: [],
    providesTools: ["code_map"],
    optionalTools: [],
    providesSlots: [],
    remedy:
      "This extension is imported directly; a failure here is a code problem in src/lib/pi/extensions/code-map.ts.",
  },
  {
    id: "code-search",
    source: { factory: codeSearchExtension, kind: "factory" },
    // After read-router, so its bash nudge is appended to the already-truncated
    // search output rather than being fed into the summariser that compresses
    // it. Pi chains tool_result handlers in extension order, passing each the
    // previous one's content.
    requires: ["read-router"],
    // Every query is scoped to one project's index, and the write hook has to
    // know which project a written path belongs to. Without an anchor there is
    // no index to search and no project to attribute a write to.
    requiresProjectAnchor: true,
    providesTools: ["code_search"],
    optionalTools: [],
    providesSlots: [],
    remedy:
      "This extension is imported directly; a failure here is a code problem in src/lib/pi/extensions/code-search.ts.",
  },
  {
    id: "open-review",
    source: { factory: openReviewExtension, kind: "factory" },
    // Resolves a target against the session's own project links and returns it
    // in `details`; depends on nothing else in the session.
    requires: [],
    providesTools: ["open_review"],
    optionalTools: [],
    providesSlots: [],
    remedy:
      "This extension is imported directly; a failure here is a code problem in src/lib/pi/extensions/open-review.ts.",
  },
  {
    id: "orient-status",
    source: { factory: orientStatusExtension, kind: "factory" },
    requires: [],
    // Every answer is about one project: which package.json, which tool
    // configs, which status file. Without an anchor there is nothing to report
    // on, and reporting against process.cwd() would be silently wrong rather
    // than empty.
    requiresProjectAnchor: true,
    providesTools: ["orient_status"],
    optionalTools: [],
    providesSlots: [],
    remedy:
      "This extension is imported directly; a failure here is a code problem in src/lib/pi/extensions/orient-status.ts.",
  },
  {
    id: "code-intelligence",
    source: { kind: "path", path: CODE_INTELLIGENCE_EXTENSION_PATH },
    requires: [],
    requiresProjectAnchor: true,
    // Exactly what the headless profile registers, which is asserted against
    // the package itself in code-intelligence-contract.test.ts rather than
    // trusted to stay true across releases.
    providesTools: [
      "code_resolve",
      "code_inspect",
      "code_orientation",
      "code_graph",
      "code_find",
      "code_health",
    ],
    optionalTools: [],
    providesSlots: [],
    remedy:
      "Run `npm install` — @mrclrchtr/supi-code-intelligence is declared in this repo's package.json and loaded from root node_modules.",
  },
  {
    id: "install-guard",
    source: { factory: installGuardExtension, kind: "factory" },
    // Blocks tool calls rather than contributing any, so it depends on nothing
    // and nothing depends on it.
    requires: [],
    providesTools: [],
    optionalTools: [],
    providesSlots: [],
    remedy:
      "This extension is imported directly; a failure here is a code problem in src/lib/pi/extensions/install-guard-extension.ts.",
  },
  {
    id: "read-router",
    source: { factory: readRouterExtension, kind: "factory" },
    // Intercepts tool results and rewrites context history. No tools provided
    // and nothing depends on it, so it sits beside install-guard.
    requires: [],
    providesTools: [],
    optionalTools: [],
    providesSlots: [],
    remedy:
      "This extension is imported directly; a failure here is a code problem in src/lib/pi/extensions/read-router.ts.",
  },
  {
    id: "jev-gate",
    source: { factory: jevGateExtension, kind: "factory" },
    // Loads last among the tool-affecting extensions on purpose: it narrows
    // the active set by calling setActiveTools, and what it may narrow is
    // whatever the other extensions have registered by then. Ordered by
    // `requires` rather than by position so the sort enforces it, and
    // `placement-tools` is included because its edit/write are candidates the
    // gate must be able to see.
    requires: ["workflow", "wiki", "mcp", "placement-tools"],
    // Contributes no tools; it only ever removes them.
    providesTools: [],
    optionalTools: [],
    providesSlots: [],
    remedy:
      "This extension is imported directly; a failure here is a code problem in src/lib/pi/extensions/jev-gate/index.ts.",
  },
  {
    id: "wiki",
    source: { kind: "path", path: WIKI_EXTENSION_PATH },
    requires: [],
    providesTools: WIKI_TOOLS,
    optionalTools: WIKI_TRAJECTORY_TOOLS,
    providesSlots: [],
    remedy:
      "Run `npm install` to install @zosmaai/pi-llm-wiki at the pinned version, and check that scripts/apply-package-patches.mjs ran.",
  },
  {
    id: "wiki-ingest-bridge",
    source: { factory: wikiIngestBridgeExtension, kind: "factory" },
    // Needs the workflow manager slot, and replaces a pi-llm-wiki code path —
    // both must already be in place when its dispatchers are installed.
    requires: ["workflow", "wiki"],
    providesTools: [],
    optionalTools: [],
    providesSlots: [WIKI_INGEST_DISPATCHER, WIKI_REINDEX_DISPATCHER],
    remedy:
      "This bridge is imported directly; a failure here is a code problem in src/lib/pi/extensions/wiki-ingest-bridge.ts.",
  },
  {
    id: "mcp",
    source: { kind: "path", path: MCP_EXTENSION_PATH },
    requires: [],
    // The gateway tool is the thing whose absence means the extension silently
    // did nothing; mcpScript can be turned off by configuration, so a session
    // must not refuse to boot over its absence — see mcp-package-contract.test.ts.
    providesTools: ["mcp"],
    optionalTools: ["mcpScript"],
    providesSlots: [],
    remedy:
      "Run `npm install` — pi-mcp-adapter is declared in this repo's package.json and loaded from root node_modules.",
  },
  {
    id: "placement-prompt",
    source: { factory: placementPromptExtension, kind: "factory" },
    // Injects PLACEMENT.md into the system prompt via before_agent_start;
    // depends on nothing else in the session.
    requires: [],
    providesTools: [],
    optionalTools: [],
    providesSlots: [],
    remedy:
      "This extension is imported directly; a failure here is a code problem in src/lib/pi/extensions/architecture-awareness/placement-prompt.ts.",
  },
  {
    id: "spec-persistence",
    source: { factory: specPersistenceExtension, kind: "factory" },
    // Appends to and injects SPEC.md via before_agent_start; independent of
    // placement-prompt even though both hook the same event.
    requires: [],
    providesTools: [],
    optionalTools: [],
    providesSlots: [],
    remedy:
      "This extension is imported directly; a failure here is a code problem in src/lib/pi/extensions/architecture-awareness/spec-persistence.ts.",
  },
  {
    id: "placement-tools",
    source: { factory: placementToolsExtension, kind: "factory" },
    // Registers replacement `edit`/`write` tools; reads PLACEMENT.md via the
    // same loader placement-prompt.ts exports, but does not need that
    // extension loaded first — it calls the loader function directly.
    requires: [],
    // Deliberately claims the built-in tool names `edit`/`write` — see the
    // named exception in assertManifestIsCoherent's collision check, and
    // session-service.ts's excludeTools wiring that keeps Pi's own
    // edit/write out of the active set so there is exactly one of each.
    providesTools: ["edit", "write"],
    optionalTools: [],
    providesSlots: [],
    remedy:
      "This extension is imported directly; a failure here is a code problem in src/lib/pi/extensions/architecture-awareness/placement-tools.ts.",
  },
] as const;

/**
 * Every tool an extension always contributes, in manifest order. Gated tools
 * are excluded on purpose — this list is what the UI advertises as available.
 */
export const EXTENSION_TOOLS: readonly string[] = EXTENSION_MANIFEST.flatMap(
  (spec) => [...spec.providesTools],
);

/**
 * The extensions a session should load.
 *
 * A session with no project — a new one before its first write attaches
 * anything, or one whose anchor has since been moved — skips the extensions
 * that only mean something inside a project. It gains them on the next turn
 * after a project appears, including one the agent attached itself.
 */
export function manifestForSession({
  projectAnchored,
}: {
  projectAnchored: boolean;
}): readonly ExtensionSpec[] {
  if (projectAnchored) return EXTENSION_MANIFEST;
  return EXTENSION_MANIFEST.filter((spec) => !spec.requiresProjectAnchor);
}

/**
 * What the UI may advertise for a session.
 *
 * Session-scoped for the same reason `optionalTools` is excluded from
 * EXTENSION_TOOLS: offering a tool the agent does not have is worse than
 * offering fewer.
 */
export function extensionToolsForSession(options: {
  projectAnchored: boolean;
}): readonly string[] {
  return manifestForSession(options).flatMap((spec) => [...spec.providesTools]);
}

// ── Load order ───────────────────────────────────────────────────────────────

/**
 * Manifest order with `requires` honoured. Deterministic: dependencies first,
 * otherwise declaration order is preserved. Throws on an unknown or cyclic
 * dependency rather than silently emitting a broken order.
 */
export function resolveExtensionLoadOrder(
  specs: readonly ExtensionSpec[] = EXTENSION_MANIFEST,
): ExtensionSpec[] {
  const byId = new Map(specs.map((spec) => [spec.id, spec]));
  const ordered: ExtensionSpec[] = [];
  const done = new Set<ExtensionId>();
  const visiting = new Set<ExtensionId>();

  const visit = (id: ExtensionId, trail: ExtensionId[]): void => {
    if (done.has(id)) return;
    if (visiting.has(id)) {
      throw new Error(
        `Cyclic Pi extension dependency: ${[...trail, id].join(" -> ")}`,
      );
    }

    const spec = byId.get(id);
    if (!spec) {
      throw new Error(
        `Pi extension "${trail[trail.length - 1]}" requires unknown extension "${id}".`,
      );
    }

    visiting.add(id);
    for (const dependency of spec.requires) {
      visit(dependency, [...trail, id]);
    }
    visiting.delete(id);
    done.add(id);
    ordered.push(spec);
  };

  for (const spec of specs) visit(spec.id, []);

  return ordered;
}

/**
 * What Pi reports as an extension's `path`, whichever way it was loaded.
 *
 * Pi labels an inline extension `<inline:{name}>`, and Semla passes the spec id
 * as that name — so this one value identifies a spec in the loaded set for both
 * kinds, and the load report needs no branch.
 */
export function extensionEntryId(spec: ExtensionSpec): string {
  return spec.source.kind === "path"
    ? spec.source.path
    : `<inline:${spec.id}>`;
}

/** The `additionalExtensionPaths` array, in dependency order. */
export function extensionPathsInLoadOrder(
  specs: readonly ExtensionSpec[] = EXTENSION_MANIFEST,
): string[] {
  return resolveExtensionLoadOrder(specs).flatMap((spec) =>
    spec.source.kind === "path" ? [spec.source.path] : [],
  );
}

/**
 * The `extensionFactories` array, in dependency order.
 *
 * Named with the spec id so Pi's `<inline:{name}>` label lines up with
 * extensionEntryId.
 */
export function extensionFactoriesInLoadOrder(
  specs: readonly ExtensionSpec[] = EXTENSION_MANIFEST,
): Array<{ factory: ExtensionFactory; name: string }> {
  return resolveExtensionLoadOrder(specs).flatMap((spec) =>
    spec.source.kind === "factory"
      ? [{ factory: spec.source.factory, name: spec.id }]
      : [],
  );
}

// ── Pre-load validation ──────────────────────────────────────────────────────

/**
 * Every entry file must exist, be a file (not a directory), and have an
 * extension jiti can import.
 *
 * This is not hypothetical: @zosmaai/pi-llm-wiki declares
 * `pi.extensions: ["./extensions"]`, a directory with no index at its root, and
 * Pi's loader silently produced no wiki tools rather than reporting it. Failing
 * here turns that class of bug into a startup error with a fix attached.
 */
export function assertExtensionPathsExist(
  specs: readonly ExtensionSpec[] = EXTENSION_MANIFEST,
): void {
  const problems: string[] = [];

  for (const spec of specs) {
    // Factories were imported at build time; a broken one is a compile error,
    // not a missing file. Only Pi's own loader needs a path checked.
    if (spec.source.kind !== "path") continue;
    const path = spec.source.path;

    if (!/\.(ts|js|mjs|cjs)$/.test(path)) {
      problems.push(
        `${spec.id}: ${path} is not an importable module file. ${spec.remedy}`,
      );
      continue;
    }

    let stat;
    try {
      stat = statSync(path);
    } catch {
      problems.push(`${spec.id}: missing at ${path}. ${spec.remedy}`);
      continue;
    }

    if (!stat.isFile()) {
      problems.push(
        `${spec.id}: ${path} is a directory, not a file. ${spec.remedy}`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(`Pi extensions cannot be loaded:\n- ${problems.join("\n- ")}`);
  }
}

/**
 * Manifest-internal consistency: no duplicate ids, no tool claimed by two
 * extensions, no extension claiming a built-in tool name. Cheap enough to run
 * at load time and covered directly by tests.
 */
export function assertManifestIsCoherent(
  specs: readonly ExtensionSpec[] = EXTENSION_MANIFEST,
): void {
  const problems: string[] = [];
  const seenIds = new Set<string>();
  const toolOwner = new Map<string, ExtensionId>();
  const builtins = new Set<string>(PI_TOOLS as readonly string[]);

  for (const spec of specs) {
    if (seenIds.has(spec.id)) problems.push(`duplicate extension id "${spec.id}"`);
    seenIds.add(spec.id);

    for (const tool of [...spec.providesTools, ...spec.optionalTools]) {
      const owner = toolOwner.get(tool);
      if (owner) {
        problems.push(
          `tool "${tool}" is claimed by both "${owner}" and "${spec.id}"`,
        );
      }
      toolOwner.set(tool, spec.id);

      // The workflow extension deliberately backs two built-in tool names,
      // and placement-tools deliberately replaces edit/write (see item 3 of
      // docs/plans/architecture-awareness.md — Pi's built-in edit/write
      // schemas cannot be extended in place, only replaced under the same
      // name). Any other collision means the UI would offer a toggle for a
      // tool an extension owns.
      const allowedCollisions: readonly ExtensionId[] = ["workflow", "ask-user", "placement-tools"];
      if (builtins.has(tool) && !allowedCollisions.includes(spec.id)) {
        problems.push(
          `tool "${tool}" from "${spec.id}" collides with a built-in Pi tool`,
        );
      }
    }
  }

  // Pi loads every path extension before any inline factory (see
  // DefaultResourceLoader.loadFinalExtensionSet), so a path extension can never
  // observe a factory. The topological sort cannot express that, and the failure
  // would be a slot read as undefined rather than an error — so it is checked.
  const byId = new Map(specs.map((spec) => [spec.id, spec]));
  for (const spec of specs) {
    if (spec.source.kind !== "path") continue;
    for (const dependency of spec.requires) {
      if (byId.get(dependency)?.source.kind === "factory") {
        problems.push(
          `"${spec.id}" is loaded from a path but requires "${dependency}", ` +
            "which is an imported factory — Pi loads all paths before any factory, " +
            `so "${dependency}" would not exist yet`,
        );
      }
    }
  }

  // An anchor-gated extension is absent for a session with no project, so
  // anything that survives that filter must not depend on one: the load order
  // would resolve against a spec that is not there and throw on an unknown
  // dependency, refusing every unanchored turn.
  for (const spec of specs) {
    if (spec.requiresProjectAnchor) continue;
    for (const dependency of spec.requires) {
      if (byId.get(dependency)?.requiresProjectAnchor) {
        problems.push(
          `"${spec.id}" requires "${dependency}", which is only loaded for a ` +
            `session anchored on a project — so "${spec.id}" must be gated the ` +
            "same way, or must not require it",
        );
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(`Pi extension manifest is inconsistent:\n- ${problems.join("\n- ")}`);
  }
}

// ── Post-load verification ───────────────────────────────────────────────────

export type ExtensionStatus = {
  id: ExtensionId;
  /** Entry file, or `<inline:{id}>` for an imported factory. */
  path: string;
  loaded: boolean;
  /** Load error reported by Pi, if any. */
  error: string | null;
  /** Declared tools that never registered. */
  missingTools: string[];
  /** Declared contract slots that were never published. */
  missingSlots: string[];
  /** Gated tools that did register this session. Diagnostic only. */
  optionalToolsPresent: string[];
};

export type ExtensionLoadReport = {
  ok: boolean;
  extensions: ExtensionStatus[];
  /** Entry files Pi loaded more than once — the tool-name-conflict failure. */
  duplicatePaths: string[];
  /**
   * Load errors for paths that are not in the manifest — e.g. a project-scope
   * package from the workspace's own .pi/settings.json. Reported and logged,
   * but deliberately NOT fatal: those extensions are outside this manifest's
   * remit and a session should not be refused because of one.
   */
  unexpectedErrors: string[];
};

export function buildExtensionLoadReport({
  loadedPaths,
  loadErrors,
  piSessionId,
  registeredTools,
  specs = EXTENSION_MANIFEST,
}: {
  loadedPaths: readonly string[];
  loadErrors: readonly { path: string; error: unknown }[];
  /**
   * The pi runtime session id this report is about.
   *
   * Session-keyed slots are verified for this session specifically. Without it
   * a concurrent session's entry would satisfy the check, which is the
   * cross-session confusion those slots are keyed to prevent — so the one
   * caller that runs a real session passes it.
   */
  piSessionId?: string;
  registeredTools: readonly string[];
  specs?: readonly ExtensionSpec[];
}): ExtensionLoadReport {
  const loadedSet = new Set(loadedPaths);
  const toolSet = new Set(registeredTools);
  const errorByPath = new Map(
    loadErrors.map(({ path, error }) => [path, String(error)]),
  );

  const seen = new Map<string, number>();
  for (const path of loadedPaths) seen.set(path, (seen.get(path) ?? 0) + 1);
  const duplicatePaths = [...seen.entries()]
    .filter(([, count]) => count > 1)
    .map(([path]) => path);

  const extensions = specs.map((spec): ExtensionStatus => {
    const entry = extensionEntryId(spec);
    const loaded = loadedSet.has(entry);
    return {
      id: spec.id,
      path: entry,
      loaded,
      error: errorByPath.get(entry) ?? null,
      // Only report missing contributions for an extension that loaded — an
      // extension that failed outright already explains itself.
      missingTools: loaded
        ? spec.providesTools.filter((tool) => !toolSet.has(tool))
        : [],
      missingSlots: loaded
        ? spec.providesSlots
            .filter((slot) => !isSlotPublished(slot, piSessionId))
            .map(slotName)
        : [],
      optionalToolsPresent: loaded
        ? spec.optionalTools.filter((tool) => toolSet.has(tool))
        : [],
    };
  });

  const manifestPaths = new Set(specs.map(extensionEntryId));
  const unexpectedErrors = loadErrors
    .filter(({ path }) => !manifestPaths.has(path))
    .map(({ path, error }) => `${path}: ${String(error)}`);

  // `ok` covers only what the manifest declares; see unexpectedErrors above.
  const ok =
    duplicatePaths.length === 0 &&
    extensions.every(
      (status) =>
        status.loaded &&
        status.error === null &&
        status.missingTools.length === 0 &&
        status.missingSlots.length === 0,
    );

  return { ok, extensions, duplicatePaths, unexpectedErrors };
}

/** Formatted, actionable description of everything wrong in a report. */
export function describeExtensionProblems(
  report: ExtensionLoadReport,
  specs: readonly ExtensionSpec[] = EXTENSION_MANIFEST,
): string[] {
  const remedyById = new Map(specs.map((spec) => [spec.id, spec.remedy]));
  const problems: string[] = [];

  for (const status of report.extensions) {
    if (!status.loaded) {
      problems.push(
        `${status.id}: did not load (${status.error ?? "no error reported"}). ${remedyById.get(status.id) ?? ""}`.trim(),
      );
      continue;
    }
    if (status.error) problems.push(`${status.id}: load error — ${status.error}`);
    if (status.missingTools.length > 0) {
      problems.push(
        `${status.id}: loaded but did not register ${status.missingTools.join(", ")}`,
      );
    }
    if (status.missingSlots.length > 0) {
      problems.push(
        `${status.id}: loaded but did not publish contract slot(s) ${status.missingSlots.join(", ")}`,
      );
    }
  }

  for (const path of report.duplicatePaths) {
    problems.push(
      `${path} was loaded more than once — a duplicate copy in the agent dir causes tool-name conflicts`,
    );
  }

  problems.push(...report.unexpectedErrors.map((e) => `unexpected extension error — ${e}`));

  return problems;
}

/** Throws unless every manifest extension loaded and contributed what it declared. */
export function assertExtensionLoad(
  report: ExtensionLoadReport,
  specs: readonly ExtensionSpec[] = EXTENSION_MANIFEST,
): void {
  if (report.ok) return;
  throw new Error(
    `Pi extensions did not load correctly:\n- ${describeExtensionProblems(report, specs).join("\n- ")}`,
  );
}
