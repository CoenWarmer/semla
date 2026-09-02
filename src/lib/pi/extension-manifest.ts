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

import {
  ACTIVE_WORKFLOW_MANAGER,
  hasSlot,
  slotName,
  WIKI_INGEST_DISPATCHER,
  WIKI_REINDEX_DISPATCHER,
  type ContractSlotKey,
} from "@/lib/pi/extension-contract";
import {
  ASK_USER_EXTENSION_PATH,
  CODE_INTELLIGENCE_EXTENSION_PATH,
  CODE_MAP_EXTENSION_PATH,
  INSTALL_GUARD_EXTENSION_PATH,
  PI_TOOLS,
  WIKI_EXTENSION_PATH,
  WIKI_INGEST_BRIDGE_PATH,
  WORKFLOW_EXTENSION_PATH,
} from "@/lib/pi/runtime-config";

export type ExtensionId =
  | "workflow"
  | "ask-user"
  | "code-map"
  | "code-intelligence"
  | "install-guard"
  | "wiki"
  | "wiki-ingest-bridge";

export type ExtensionSpec = {
  /** Stable identifier, used in `requires` and in diagnostics. */
  id: ExtensionId;
  /** Absolute path to the entry file handed to Pi's resource loader. */
  path: string;
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
    path: WORKFLOW_EXTENSION_PATH,
    requires: [],
    providesTools: ["workflow", "workflow_control"],
    optionalTools: [],
    // Published from the extension's session_start handler, which runs during
    // bindExtensions() — so it is present by the time verification runs.
    providesSlots: [ACTIVE_WORKFLOW_MANAGER],
    remedy:
      "This extension lives in this repo; a load error here is a code or import problem in src/lib/pi/extensions/workflow.ts.",
  },
  {
    id: "ask-user",
    path: ASK_USER_EXTENSION_PATH,
    requires: [],
    providesTools: ["ask_user"],
    optionalTools: [],
    providesSlots: [],
    remedy:
      "This extension lives in this repo; a load error here is a code or import problem in src/lib/pi/extensions/ask-user.ts.",
  },
  {
    id: "code-map",
    path: CODE_MAP_EXTENSION_PATH,
    // Reads the project with the TypeScript checker and returns a structured
    // map; depends on nothing else in the session.
    requires: [],
    providesTools: ["code_map"],
    optionalTools: [],
    providesSlots: [],
    remedy:
      "This extension lives in this repo; a load error here is a code or import problem in src/lib/pi/extensions/code-map.ts.",
  },
  {
    id: "code-intelligence",
    path: CODE_INTELLIGENCE_EXTENSION_PATH,
    requires: [],
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
    path: INSTALL_GUARD_EXTENSION_PATH,
    // Blocks tool calls rather than contributing any, so it depends on nothing
    // and nothing depends on it.
    requires: [],
    providesTools: [],
    optionalTools: [],
    providesSlots: [],
    remedy:
      "This extension lives in this repo; a load error here is a code or import problem in src/lib/pi/extensions/install-guard-extension.ts.",
  },
  {
    id: "wiki",
    path: WIKI_EXTENSION_PATH,
    requires: [],
    providesTools: WIKI_TOOLS,
    optionalTools: WIKI_TRAJECTORY_TOOLS,
    providesSlots: [],
    remedy:
      "Run `npm install --prefix .pi/npm` to install @zosmaai/pi-llm-wiki at the pinned version.",
  },
  {
    id: "wiki-ingest-bridge",
    path: WIKI_INGEST_BRIDGE_PATH,
    // Needs the workflow manager slot, and replaces a pi-llm-wiki code path —
    // both must already be in place when its dispatchers are installed.
    requires: ["workflow", "wiki"],
    providesTools: [],
    optionalTools: [],
    providesSlots: [WIKI_INGEST_DISPATCHER, WIKI_REINDEX_DISPATCHER],
    remedy:
      "This bridge lives in this repo; a load error here is a code or import problem in src/lib/pi/extensions/wiki-ingest-bridge.ts.",
  },
] as const;

/**
 * Every tool an extension always contributes, in manifest order. Gated tools
 * are excluded on purpose — this list is what the UI advertises as available.
 */
export const EXTENSION_TOOLS: readonly string[] = EXTENSION_MANIFEST.flatMap(
  (spec) => [...spec.providesTools],
);

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

/** The `additionalExtensionPaths` array, in dependency order. */
export function extensionPathsInLoadOrder(
  specs: readonly ExtensionSpec[] = EXTENSION_MANIFEST,
): string[] {
  return resolveExtensionLoadOrder(specs).map((spec) => spec.path);
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
    if (!/\.(ts|js|mjs|cjs)$/.test(spec.path)) {
      problems.push(
        `${spec.id}: ${spec.path} is not an importable module file. ${spec.remedy}`,
      );
      continue;
    }

    let stat;
    try {
      stat = statSync(spec.path);
    } catch {
      problems.push(`${spec.id}: missing at ${spec.path}. ${spec.remedy}`);
      continue;
    }

    if (!stat.isFile()) {
      problems.push(
        `${spec.id}: ${spec.path} is a directory, not a file. ${spec.remedy}`,
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

      // The workflow extension deliberately backs two built-in tool names; any
      // other collision means the UI would offer a toggle for a tool an
      // extension owns.
      if (builtins.has(tool) && spec.id !== "workflow" && spec.id !== "ask-user") {
        problems.push(
          `tool "${tool}" from "${spec.id}" collides with a built-in Pi tool`,
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
  registeredTools,
  specs = EXTENSION_MANIFEST,
}: {
  loadedPaths: readonly string[];
  loadErrors: readonly { path: string; error: unknown }[];
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
    const loaded = loadedSet.has(spec.path);
    return {
      id: spec.id,
      path: spec.path,
      loaded,
      error: errorByPath.get(spec.path) ?? null,
      // Only report missing contributions for an extension that loaded — an
      // extension that failed outright already explains itself.
      missingTools: loaded
        ? spec.providesTools.filter((tool) => !toolSet.has(tool))
        : [],
      missingSlots: loaded
        ? spec.providesSlots.filter((slot) => !hasSlot(slot)).map(slotName)
        : [],
      optionalToolsPresent: loaded
        ? spec.optionalTools.filter((tool) => toolSet.has(tool))
        : [],
    };
  });

  const manifestPaths = new Set(specs.map((spec) => spec.path));
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
