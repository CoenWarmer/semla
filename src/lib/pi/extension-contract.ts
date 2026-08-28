/**
 * The cross-extension contract.
 *
 * Semla's Pi extensions do not talk to each other through Pi's API. Each one is
 * loaded into its own module scope (pi-coding-agent imports them via jiti), so
 * the only thing they genuinely share is `globalThis`. They cooperate by
 * parking values in well-known `Symbol.for()` slots: the workflow extension
 * publishes its manager, the wiki bridge publishes dispatchers, session-service
 * publishes a run notifier.
 *
 * Every participant used to re-declare those `Symbol.for("...")` calls as bare
 * string literals in its own file. A typo there is not a type error — it is a
 * slot nobody ever reads, which degrades silently (ingest quietly falls back to
 * inline synthesis, background results are never delivered). This module is the
 * single declaration site, so a mismatch cannot happen between Semla's own
 * files.
 *
 * IMPORTANT: the *string* values below are the wire format, and one participant
 * is outside this repo — @zosmaai/pi-llm-wiki hardcodes
 * "semla.wiki-ingest-dispatcher" and "semla.wiki-reindex-dispatcher" in its own
 * lib/tools.ts. Renaming a key here silently unhooks that package. The strings
 * are asserted in extension-contract.test.ts, including against the installed
 * copy of the package.
 *
 * Importable from both sides of the divide: it has no runtime dependencies and
 * no "@/" imports, so jiti can load it from an extension file (which cannot
 * resolve Next.js path aliases) just as well as the Next.js server can.
 */

/**
 * Bumped when a slot's payload shape changes in a way an out-of-tree consumer
 * would notice. Exposed by the health endpoint so a stale participant is
 * visible rather than merely broken.
 */
export const EXTENSION_CONTRACT_VERSION = 1;

// ── Slot keys ────────────────────────────────────────────────────────────────
// `const x = Symbol.for(...)` infers `unique symbol`, which is what lets these
// be used as computed keys in the ContractSlots interface below.

/** Published by workflow.ts on session_start; read by wiki-ingest-bridge.ts. */
export const ACTIVE_WORKFLOW_MANAGER = Symbol.for(
  "semla.active-workflow-manager",
);

/** Toolsets registered after manager construction; read by workflow.ts's Proxy. */
export const WORKFLOW_EXTRA_TOOLSETS = Symbol.for(
  "semla.workflow.extra-toolsets",
);

/** Read by @zosmaai/pi-llm-wiki (external). Set by wiki-ingest-bridge.ts. */
export const WIKI_INGEST_DISPATCHER = Symbol.for("semla.wiki-ingest-dispatcher");

/** Read by @zosmaai/pi-llm-wiki (external). Set by wiki-ingest-bridge.ts. */
export const WIKI_REINDEX_DISPATCHER = Symbol.for(
  "semla.wiki-reindex-dispatcher",
);

/** Published per prompt turn by session-service.ts; called by the wiki bridge. */
export const BRIDGE_RUN_STARTED = Symbol.for("semla.bridge-run-started");

/** Run-id → manager registry, shared with workflow-manager-registry.ts. */
export const WORKFLOW_MANAGER_REGISTRY = Symbol.for("semla.workflow.managers");

/**
 * Last observed extension-load result, published by session-service and read by
 * the health endpoint. Internal to the Next server — no extension reads it — but
 * it crosses module scopes for the same reason the others do, and reusing the
 * one typed mechanism beats inventing a second untyped one.
 */
export const EXTENSION_HEALTH = Symbol.for("semla.extension-health");

// ── Payload types ────────────────────────────────────────────────────────────
// Structural on purpose: importing the real WorkflowManager here would drag the
// dynamic-workflows tree into every consumer's type graph, including files that
// are loaded by jiti outside the app's module resolution.

/** The slice of WorkflowManager the wiki bridge actually calls. */
export interface WorkflowManagerLike {
  startInBackground(
    script: string,
    args?: unknown,
    exec?: { toolset?: string; suppressDelivery?: boolean },
  ): { runId: string };
}

/** The slice of WorkflowManager the /workflows API route actually calls. */
export interface WorkflowSnapshotSource {
  getSnapshot(runId: string): unknown;
}

/** A tool factory keyed by toolset name, resolved lazily at agent-launch time. */
export type ExtraToolsets = Record<string, () => unknown[]>;

/** One captured-but-unsynthesized wiki source, as handed over by pi-llm-wiki. */
export type WikiIngestSource = {
  id: string;
  extracted: string;
  manifest: Record<string, unknown>;
};

/** Returns true when the bridge took ownership of the batch. */
export type WikiIngestDispatcher = (sources: WikiIngestSource[]) => boolean;

/** Returns true when the bridge took ownership of the reindex. */
export type WikiReindexDispatcher = (args: {
  paths: unknown;
  embedder: unknown;
  force: boolean;
}) => boolean;

/** A snapshot of how the extension set loaded, as seen by the last session. */
export type ExtensionHealthSnapshot = {
  observedAt: string;
  ok: boolean;
  report: unknown;
};

/**
 * Tells session-service about a run the bridge started directly, i.e. without
 * going through the `workflow` tool. `primary` marks the run whose completion
 * should arm a background continuation.
 */
export type BridgeRunNotifier = (
  runId: string,
  opts?: { primary?: boolean },
) => void;

// ── Typed slot access ────────────────────────────────────────────────────────

export interface ContractSlots {
  [ACTIVE_WORKFLOW_MANAGER]: WorkflowManagerLike;
  [WORKFLOW_EXTRA_TOOLSETS]: ExtraToolsets;
  [WIKI_INGEST_DISPATCHER]: WikiIngestDispatcher;
  [WIKI_REINDEX_DISPATCHER]: WikiReindexDispatcher;
  [BRIDGE_RUN_STARTED]: BridgeRunNotifier;
  [WORKFLOW_MANAGER_REGISTRY]: Map<string, WeakRef<WorkflowSnapshotSource>>;
  [EXTENSION_HEALTH]: ExtensionHealthSnapshot;
}

export type ContractSlotKey = keyof ContractSlots;

const slots = globalThis as unknown as Partial<ContractSlots>;

/** Read a contract slot. `undefined` means the publishing side has not run yet. */
export function readSlot<K extends ContractSlotKey>(
  key: K,
): ContractSlots[K] | undefined {
  return slots[key];
}

/** Publish a contract slot. */
export function writeSlot<K extends ContractSlotKey>(
  key: K,
  value: ContractSlots[K],
): void {
  slots[key] = value;
}

/** Read a slot, initialising it with `fallback` when empty. */
export function readOrInitSlot<K extends ContractSlotKey>(
  key: K,
  fallback: () => ContractSlots[K],
): ContractSlots[K] {
  return (slots[key] ??= fallback()) as ContractSlots[K];
}

/** Clear a contract slot. */
export function clearSlot(key: ContractSlotKey): void {
  delete slots[key];
}

/** True when a slot is currently populated. Used by post-load verification. */
export function hasSlot(key: ContractSlotKey): boolean {
  return slots[key] !== undefined;
}

/** Every key in the contract, for diagnostics and verification. */
export const CONTRACT_SLOT_KEYS = [
  ACTIVE_WORKFLOW_MANAGER,
  WORKFLOW_EXTRA_TOOLSETS,
  WIKI_INGEST_DISPATCHER,
  WIKI_REINDEX_DISPATCHER,
  BRIDGE_RUN_STARTED,
  WORKFLOW_MANAGER_REGISTRY,
  EXTENSION_HEALTH,
] as const satisfies readonly ContractSlotKey[];

/** Human-readable slot name, for error messages and the health endpoint. */
export function slotName(key: ContractSlotKey): string {
  return key.description ?? String(key);
}
