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

/**
 * Published by workflow.ts on session_start; read by wiki-ingest-bridge.ts.
 *
 * Keyed by pi session id — see SessionKeyedSlotKey for why, and
 * readSessionWorkflowManager for why the entries are weak.
 */
export const ACTIVE_WORKFLOW_MANAGER = Symbol.for(
  "semla.active-workflow-manager",
);

/** Toolsets registered after manager construction; read by workflow.ts's Proxy. */
export const WORKFLOW_EXTRA_TOOLSETS = Symbol.for(
  "semla.workflow.extra-toolsets",
);

/**
 * Read by @zosmaai/pi-llm-wiki (external). Set by wiki-ingest-bridge.ts.
 *
 * Deliberately *not* session-keyed, unlike the slots below. These two are read
 * by a package outside this repository, which looks the symbol up and calls
 * whatever it finds as a plain function — it cannot index a session map, and
 * teaching it to would put the key format itself in the wire contract.
 *
 * The session travels as an argument instead: the dispatcher takes the calling
 * session's id and resolves the manager and the repo from it, so the closure is
 * session-agnostic and last-writer-wins over the slot is harmless. Keyed state
 * with an unkeyed entry point, which is the shape an external caller can
 * actually satisfy. Without it, a batch dispatched by session A ran through
 * whichever bridge instance wrote the slot last and was attributed to B's repo.
 *
 * The id is supplied by a `patches/` change to the package — see
 * `wiki-package-contract.test.ts`, which asserts both that the symbol is still
 * read and that the argument is still passed, because losing either is silent.
 */
export const WIKI_INGEST_DISPATCHER = Symbol.for("semla.wiki-ingest-dispatcher");

/** Read by @zosmaai/pi-llm-wiki (external). See WIKI_INGEST_DISPATCHER. */
export const WIKI_REINDEX_DISPATCHER = Symbol.for(
  "semla.wiki-reindex-dispatcher",
);

/**
 * Read by @zosmaai/pi-llm-wiki (external). Set by wiki-ingest-bridge.ts.
 *
 * Narrows the per-turn auto-recall injection to the repos the calling session
 * is actually working in. The package's `before_agent_start` hook searches the
 * whole vault and cannot do this itself: `process.cwd()` names one directory,
 * while a Semla session can be anchored to several projects, and only
 * WIKI_SESSION_REPOS knows which. Measured over 441 real injections, 47.4% of
 * the pages offered belonged to a repo the session was not in.
 *
 * Unkeyed for the same reason as the two dispatchers above — an external
 * caller cannot index a session map — so the session id travels as an
 * argument. With no id the filter must pass everything through: injecting too
 * much is recoverable, and silently injecting nothing is not.
 *
 * Supplied by a `patches/` change to the package, asserted in
 * `wiki-package-contract.test.ts`.
 */
export const WIKI_RECALL_FILTER = Symbol.for("semla.wiki-recall-filter");

/**
 * Published per prompt turn by session-service.ts; called by the wiki bridge.
 *
 * Keyed by pi session id — see SessionKeyedSlotKey. Unkeyed, two concurrent
 * sessions' turns overwrote each other's notifier, so a run started by one was
 * announced to the other's event router; and the turn-end clear was
 * unguarded, so whichever turn ended first left the other's bridge runs
 * reporting no progress at all.
 */
export const BRIDGE_RUN_STARTED = Symbol.for("semla.bridge-run-started");

/**
 * Pi session id → repo slug, published by session-service and read by the wiki
 * bridge to attribute captured sources.
 *
 * Keyed rather than a bare value because concurrent orient sessions share one
 * process: a single "current repo" slot would be overwritten by whichever
 * session started last, which is the misattribution this exists to prevent.
 */
export const WIKI_SESSION_REPOS = Symbol.for("semla.wiki.session-repos");

/** Run-id → manager registry, shared with workflow-manager-registry.ts. */
export const WORKFLOW_MANAGER_REGISTRY = Symbol.for("semla.workflow.managers");

/**
 * Last observed extension-load result, published by session-service and read by
 * the health endpoint. Internal to the Next server — no extension reads it — but
 * it crosses module scopes for the same reason the others do, and reusing the
 * one typed mechanism beats inventing a second untyped one.
 */
export const EXTENSION_HEALTH = Symbol.for("semla.extension-health");

/**
 * The `ask_user` rendezvous — see RendezvousSlot, and session-rendezvous.ts for
 * the only code that touches it.
 */
export const ASK_USER_RENDEZVOUS = Symbol.for("semla.ask-user.rendezvous");

/** The `capture_feature_spec` rendezvous. See ASK_USER_RENDEZVOUS. */
export const FEATURE_SPEC_RENDEZVOUS = Symbol.for(
  "semla.feature-spec.rendezvous",
);

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
  /**
   * Progress events for runs the host did not start through the `workflow`
   * tool. The session only sees tool-execution updates, so a run dispatched
   * straight into the manager — every wiki ingest — reported no progress at
   * all. Optional because the contract is satisfied by dispatching alone.
   */
  on?(event: string, listener: (payload: unknown) => void): void;
  off?(event: string, listener: (payload: unknown) => void): void;
  getSnapshot?(runId: string): unknown;
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

/**
 * Returns true when the bridge took ownership of the batch.
 *
 * `sessionId` is the session whose agent called `wiki_ingest`. Optional only
 * because an unpatched package would omit it — see WIKI_INGEST_DISPATCHER.
 */
export type WikiIngestDispatcher = (
  sources: WikiIngestSource[],
  sessionId?: string,
) => boolean;

/**
 * One page pi-llm-wiki is about to auto-inject, as the filter sees it.
 *
 * The package passes its own `RecallResult` objects, which carry a title,
 * preview and type as well. Only these three are named because they are all
 * the filter reads — `path` rather than `id` is what identifies the page on
 * disk, and reading `repo:` from the file avoids depending on the registry
 * being current.
 */
export type WikiRecallCandidate = {
  id: string;
  /** Absolute path to the page's `.md` file. */
  path: string;
  score: number;
};

/**
 * Drops pages that belong to another repo, preserving order.
 *
 * Must return the *same object references* it was given rather than copies:
 * the package carries fields this type does not name and goes on to render
 * them. Returning everything is the correct answer when the session's repos
 * are unknown — see WIKI_RECALL_FILTER.
 */
export type WikiRecallFilter = (
  candidates: readonly WikiRecallCandidate[],
  sessionId?: string,
) => WikiRecallCandidate[];

/** Returns true when the bridge took ownership of the reindex. */
export type WikiReindexDispatcher = (args: {
  paths: unknown;
  embedder: unknown;
  force: boolean;
  /** See WikiIngestDispatcher. */
  sessionId?: string;
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

/** A tool blocked on the browser: settle it with `resolve`, or fail it. */
export type RendezvousWaiter = {
  reject: (error: Error) => void;
  resolve: (response: unknown) => void;
};

/**
 * One tool's request/response rendezvous with the browser, keyed by session id.
 *
 * `notifiers` holds the session's outbound channel (session-service registers
 * one that emits onto the SSE stream); `waiting` holds the tool call currently
 * blocked on a reply. Both maps together are the whole state, which is why they
 * are one slot rather than two — a slot holding only half of it is not a state
 * any caller can use.
 *
 * Payloads are `unknown` because ContractSlots is a fixed interface and cannot
 * take a type parameter per tool. `createSessionRendezvous` owns both ends of a
 * slot and applies the concrete request and response types at its own boundary,
 * so no caller sees the `unknown`.
 *
 * Not a SessionKeyedSlotKey: those hold one value per session behind keying the
 * contract itself manages, and `readSessionSlot` would hand out one of these
 * two maps without the other.
 */
export type RendezvousSlot = {
  notifiers: Map<string, (request: unknown) => void>;
  waiting: Map<string, RendezvousWaiter>;
};

export type RendezvousSlotKey =
  | typeof ASK_USER_RENDEZVOUS
  | typeof FEATURE_SPEC_RENDEZVOUS;

// ── Typed slot access ────────────────────────────────────────────────────────

export interface ContractSlots {
  /** Weak, and keyed by session — see readSessionWorkflowManager. */
  [ACTIVE_WORKFLOW_MANAGER]: Map<string, WeakRef<WorkflowManagerLike>>;
  [WORKFLOW_EXTRA_TOOLSETS]: ExtraToolsets;
  [WIKI_INGEST_DISPATCHER]: WikiIngestDispatcher;
  [WIKI_REINDEX_DISPATCHER]: WikiReindexDispatcher;
  [WIKI_RECALL_FILTER]: WikiRecallFilter;
  /** Keyed by session — see SessionKeyedSlotKey. */
  [BRIDGE_RUN_STARTED]: Map<string, BridgeRunNotifier>;
  /**
   * Session id → the repo slugs its wiki pages should be attributed to.
   *
   * A list since a session can work in several repositories. Written by
   * wiki-session-repo.ts through Next's module graph and read by the bridge
   * through jiti, which is why this declaration is the only thing keeping the
   * two halves agreeing — and why a mismatch would be silent misattribution
   * rather than an error.
   */
  [WIKI_SESSION_REPOS]: Map<string, string[]>;
  [WORKFLOW_MANAGER_REGISTRY]: Map<string, WeakRef<WorkflowSnapshotSource>>;
  [EXTENSION_HEALTH]: ExtensionHealthSnapshot;
  [ASK_USER_RENDEZVOUS]: RendezvousSlot;
  [FEATURE_SPEC_RENDEZVOUS]: RendezvousSlot;
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
  WIKI_RECALL_FILTER,
  BRIDGE_RUN_STARTED,
  WIKI_SESSION_REPOS,
  WORKFLOW_MANAGER_REGISTRY,
  EXTENSION_HEALTH,
  ASK_USER_RENDEZVOUS,
  FEATURE_SPEC_RENDEZVOUS,
] as const satisfies readonly ContractSlotKey[];

/** Human-readable slot name, for error messages and the health endpoint. */
export function slotName(key: ContractSlotKey): string {
  return key.description ?? String(key);
}

// ── Session-keyed slots ──────────────────────────────────────────────────────

/**
 * Slots whose payload belongs to one session rather than to the process.
 *
 * Semla runs sessions concurrently on purpose: `session-turn-lock.ts` keys its
 * registry by session, so it serialises turns *within* a session and permits
 * them across sessions — which is the concurrency `session-concurrency.ts`
 * exists to surface. A bare slot holding a session-scoped value is therefore
 * whichever session wrote last, and every failure that follows is silent: a
 * wiki ingest dispatched into another session's workflow manager, a background
 * run announced to another session's event router, an unguarded clear leaving a
 * live session with no notifier at all.
 *
 * WIKI_SESSION_REPOS was keyed from the start for exactly this reason. The
 * other two were not; this is the mechanism that makes all three one shape.
 *
 * The key is the **pi runtime** session id — `sessionManager.getSessionId()` —
 * because it is the only identity every participant can see: the workflow
 * extension and the wiki bridge read it off `ctx.sessionManager` on
 * session_start, and session-service holds it as `piRuntimeSessionId`.
 *
 * It holds the same *value* as the Semla session id: `createSessionFile` names
 * the session file after that id and writes it into the session header, and the
 * header is where pi reads its own session id from. Semla only ever moves the
 * leaf pointer (`branch`, `resetLeaf`), never `createBranchedSession`, so pi
 * does not reassign it mid-session. That equality is what lets
 * session-rendezvous.ts register under the Semla id and be found by a tool
 * holding pi's. What this is emphatically not is the `pi_sessions` row id — a
 * mistake this repository has already made once (see the docblock on
 * `piRuntimeSessionId` in session-service.ts).
 */
export type SessionKeyedSlotKey =
  | typeof ACTIVE_WORKFLOW_MANAGER
  | typeof BRIDGE_RUN_STARTED
  | typeof WIKI_SESSION_REPOS;

export const SESSION_KEYED_SLOT_KEYS = [
  ACTIVE_WORKFLOW_MANAGER,
  BRIDGE_RUN_STARTED,
  WIKI_SESSION_REPOS,
] as const satisfies readonly SessionKeyedSlotKey[];

export function isSessionKeyedSlot(
  key: ContractSlotKey,
): key is SessionKeyedSlotKey {
  return (SESSION_KEYED_SLOT_KEYS as readonly ContractSlotKey[]).includes(key);
}

/** The per-session value behind a keyed slot, with the Map wrapper removed. */
type SessionValue<K extends SessionKeyedSlotKey> =
  ContractSlots[K] extends Map<string, infer V> ? V : never;

const sessionMap = <K extends SessionKeyedSlotKey>(
  key: K,
): Map<string, SessionValue<K>> =>
  readOrInitSlot(key, () => new Map() as ContractSlots[K]) as Map<
    string,
    SessionValue<K>
  >;

/**
 * Publish a session's value. A caller with no session id is a no-op rather
 * than an error, matching setSessionRepos: the slot is an optimisation for
 * cross-module reach, and there is no one for an unkeyed value to reach.
 */
export function writeSessionSlot<K extends SessionKeyedSlotKey>(
  key: K,
  sessionId: string | undefined,
  value: SessionValue<K>,
): void {
  if (!sessionId) return;
  sessionMap(key).set(sessionId, value);
}

export function readSessionSlot<K extends SessionKeyedSlotKey>(
  key: K,
  sessionId: string | undefined,
): SessionValue<K> | undefined {
  if (!sessionId) return undefined;
  return sessionMap(key).get(sessionId);
}

/**
 * Drop a session's entry, optionally identity-guarded.
 *
 * Pass `expected` — the value this caller published — so a turn that has
 * already been superseded cannot delete the entry belonging to the turn that
 * displaced it. That is the same guard, for the same reason, as
 * `TurnSlot.finish()` in session-turn-lock.ts.
 */
export function clearSessionSlot<K extends SessionKeyedSlotKey>(
  key: K,
  sessionId: string | undefined,
  expected?: SessionValue<K>,
): void {
  if (!sessionId) return;
  const map = sessionMap(key);
  if (expected !== undefined && map.get(sessionId) !== expected) return;
  map.delete(sessionId);
}

/**
 * The workflow manager for a session, or undefined if none is published.
 *
 * Entries are `WeakRef`s, like WORKFLOW_MANAGER_REGISTRY's: the workflow
 * extension holds the manager in its own factory closure (`let manager` in
 * extensions/workflow.ts), which Pi keeps for as long as it keeps the
 * extension — so for the session's life. A strong entry here would add a
 * manager retained per session for the life of the server instead, and nothing
 * can clear one at turn end because a background continuation runs *after* the
 * turn's `finally` and can still dispatch wiki ingests through it.
 *
 * A dead ref is pruned on read rather than left to accumulate a key per
 * session, which is what getActiveManager does with the run-keyed registry.
 */
export function readSessionWorkflowManager(
  sessionId: string | undefined,
): WorkflowManagerLike | undefined {
  const ref = readSessionSlot(ACTIVE_WORKFLOW_MANAGER, sessionId);
  if (!ref) return undefined;
  const manager = ref.deref();
  if (!manager) {
    clearSessionSlot(ACTIVE_WORKFLOW_MANAGER, sessionId, ref);
    return undefined;
  }
  return manager;
}

export function publishSessionWorkflowManager(
  sessionId: string | undefined,
  manager: WorkflowManagerLike,
): void {
  writeSessionSlot(ACTIVE_WORKFLOW_MANAGER, sessionId, new WeakRef(manager));
}

/**
 * Whether an extension actually published a slot, as the load report asks it.
 *
 * Every per-slot rule lives here rather than in extension-manifest.ts: a keyed
 * slot has to be checked for *this* session, or verification passes on another
 * session's entry, and the manager's weak entry has to be dereferenced or a
 * collected manager reads as published.
 *
 * With no session id the question collapses to the one the unkeyed check used
 * to ask — did the publishing side run at all — which is what a caller that has
 * not bound a session yet can meaningfully verify.
 */
export function isSlotPublished(
  key: ContractSlotKey,
  sessionId?: string,
): boolean {
  if (!isSessionKeyedSlot(key)) return hasSlot(key);

  // Shape-checked rather than cast: every slot is reachable by string from any
  // module in the process, so a participant can put something else here. An
  // unusable slot is one the manifest should report as unpublished — which
  // names the extension and attaches its remedy — not one that throws out of
  // the load report and refuses the session with a TypeError.
  const map = readSlot(key);
  if (!(map instanceof Map)) return false;

  if (key === ACTIVE_WORKFLOW_MANAGER) {
    const alive = (ref: unknown): boolean =>
      ref instanceof WeakRef && ref.deref() !== undefined;
    if (!sessionId) return [...map.values()].some(alive);
    return alive(map.get(sessionId));
  }
  return sessionId ? map.has(sessionId) : map.size > 0;
}
