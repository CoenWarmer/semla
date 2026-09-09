/**
 * Types for the workflow subagent runner (see agent.ts).
 *
 * Split out of agent.ts so the runner file reads as the run loop it is: these
 * are declarations only — no behavior, no module state — and every one of them
 * is part of the public surface the workflow layer programs against.
 */

import type { Static, TSchema } from "typebox";
import type {
  CreateAgentSessionOptions,
  ModelRegistry,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentContextSignals } from "./agent-context-signals.ts";
import type { AgentHistoryEntry } from "./agent-history.ts";

/** Minimal session surface resolveStructuredOutput needs (real session or a test double). */
export interface StructuredSession {
  prompt(text: string): Promise<void>;
  setActiveToolsByName?(names: string[]): void;
  messages: unknown[];
}

export interface WorkflowAgentOptions {
  cwd?: string;
  /** Extra tools available to the subagent in addition to the structured output tool. */
  tools?: ToolDefinition[];
  /**
   * Extra tool NAMES to deny in the subagent session, on top of the always-on
   * defaults ({@link DEFAULT_EXCLUDED_SUBAGENT_TOOLS}). Lets the host exclude
   * other recursive-orchestration tools it registers (e.g. a pi-subagents tool)
   * so a workflow subagent can't fan out through them either (#107).
   */
  excludeTools?: string[];
  /** Override any createAgentSession option (model, modelRuntime, resourceLoader, etc.). */
  session?: Partial<CreateAgentSessionOptions>;
  /** Extra system guidance prepended to every subagent task. */
  instructions?: string;
  /**
   * The session's main model (`provider/modelId`). Used as a fallback when
   * resolving opts.tier and no model-tiers.json config exists. Without this,
   * a workflow using `{ tier: "small" }` would log a warning and fall through
   * to the session default when no config is saved yet.
   */
  mainModel?: string;
  /**
   * Shared model registry from the host Pi session. When provided, subagents
   * resolve tier/model specs against the same registry the main session uses,
   * including dynamically-registered providers such as ollama-cloud. Without
   * this, the agent builds an isolated registry from disk and may miss models
   * that are only available via extension registration.
   */
  modelRegistry?: ModelRegistry;
  /**
   * Persist each subagent transcript as a real pi session file under the
   * standard sessions directory (keyed by the runner's project cwd), instead
   * of the default in-memory session that is discarded when the run ends.
   * Default: false (current behavior).
   */
  persistAgentSessions?: boolean;
}

/** Real token/cost usage for a single subagent run, read from the SDK session. */
export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
}

export interface AgentRunOptions<
  TSchemaDef extends TSchema | undefined = undefined,
> {
  label?: string;
  /**
   * Display name recorded on the persisted session (session_info entry) when
   * `persistAgentSessions` is enabled, so transcripts are identifiable in
   * session pickers (e.g. `workflow:<runId> <label>`). Ignored for in-memory
   * sessions or when an explicit session.sessionManager override is injected.
   */
  sessionName?: string;
  schema?: TSchemaDef;
  tools?: ToolDefinition[];
  instructions?: string;
  signal?: AbortSignal;
  /**
   * Called once with this subagent's real usage, read from the session right
   * before disposal. Fires on both the success and error paths so partial
   * usage is never lost — but NOT when the provider reported no usage at all
   * (all-zero stats), so consumers keep their scalar fallback.
   */
  onUsage?: (usage: AgentUsage) => void;
  /**
   * Called once with this subagent's context-pressure signals (compaction
   * count/reasons, last assistant stopReason), read from the session's own
   * event stream right before disposal. Diagnostic only, per
   * docs/plans/subagent-context-pressure.md §4.1: never changes what run()
   * returns or throws, and (like onUsage) fires from the `finally` block so
   * it reports on both the success and error paths. Best-effort — a failure
   * reading signals is swallowed exactly like a failure reading usage.
   */
  onContextSignals?: (signals: AgentContextSignals) => void;
  /**
   * Model spec for this subagent: either `provider/modelId` (unambiguous) or a
   * bare `modelId`, parsed with the same grammar as Pi CLI's `--model`. When it
   * can't be resolved to a known model, `run()` throws MODEL_NOT_FOUND rather
   * than silently substituting the session default — a wrong-model run would
   * otherwise look successful while quietly answering with different (or
   * unauthenticated) weights. When omitted, the session default applies.
   */
  model?: string;
  /**
   * Model tier name (e.g. "small", "medium", "big"). When set (and no explicit
   * `model` is given), the model is resolved from the user's model-tiers.json
   * config before `run()` starts, falling back to the session's main model when
   * the tier has no configured entry. An explicit `model` always takes priority,
   * so workflow scripts can use `{ tier: "small" }` for coarse routing without
   * caring which concrete model backs that tier.
   *
   * A script-requested tier that resolves to an unavailable model spec is just
   * as loud as an explicit `model` pin — `run()` throws MODEL_NOT_FOUND naming
   * the tier and the spec it resolved to, e.g. `tier "big" from
   * model-tiers.json resolves to "deadprov/x", which is not available`.
   *
   * That's deliberately asymmetric with the IMPLICIT default tier an untagged
   * agent (neither `model` nor `tier` set) gets routed through: since the
   * script never asked for that tier, a broken default degrades to the
   * session default instead of failing every untagged agent in the run — see
   * onModelFallback below for how that degrade stays visible.
   */
  tier?: string;
  /** Called with the resolved model id once known (for display/telemetry). */
  onModelResolved?: (modelId: string) => void;
  /**
   * Called (at most once per WorkflowAgent instance) when an UNTAGGED agent's
   * implicit default "medium" tier resolves to a model spec that isn't
   * available. This is the one case that degrades to the session default
   * instead of throwing MODEL_NOT_FOUND (see `tier` above) — but the degrade
   * must still land in the run's own log/event stream, not just a
   * console.warn, or a broken default tier silently drifts every untagged
   * agent's model with zero trace in the run itself.
   */
  onModelFallback?: (info: { tier: string; requestedSpec: string }) => void;
  /** Called with a compact snapshot of this subagent's message/tool history. */
  onHistory?: (history: AgentHistoryEntry[]) => void;
  /** Run this agent in a different working directory (e.g. an isolated worktree). */
  cwd?: string;
  /**
   * Restrict the subagent's coding tools to these names (an agentType
   * definition's `tools` allowlist). Undefined = all coding tools. The
   * structured_output tool is always added after this filter, so a schema
   * still works under a restrictive allowlist.
   */
  toolNames?: string[];
  /** Remove these coding-tool names after the allowlist (an agentType `disallowedTools` denylist). */
  disallowedToolNames?: string[];
  /**
   * With `schema`: how many extra repair turns to allow if the model finishes
   * without calling structured_output. Each retry re-prompts (tools restricted to
   * structured_output) before falling back to strict prose extraction. Default 2.
   */
  maxSchemaRetries?: number;
  /**
   * Tools that are always injected AFTER the tool-policy filter (`toolNames` /
   * `disallowedToolNames`), so they are available even under a restrictive
   * allowlist. Used by the workflow runtime to inject shared-store tools into
   * every agent regardless of its agentType definition.
   */
  systemTools?: ToolDefinition[];
  /**
   * Per-run model registry override. Takes precedence over the constructor's
   * `modelRegistry` (WorkflowAgentOptions.modelRegistry) for both model
   * resolution and the `createAgentSession` call this run makes. Falls back to
   * the constructor's shared registry, then a lazily-built disk registry, when
   * omitted.
   */
  modelRegistry?: ModelRegistry;
  /**
   * Opt this single subagent's session into or out of pi's own auto-compaction
   * (docs/plans/subagent-context-pressure.md §7). Applied as an in-memory
   * settings override on the fresh SettingsManager this run builds — it never
   * calls SettingsManager.setCompactionEnabled/save(), so it can't persist to
   * this run's (or any other subagent's) settings.json and can't race a
   * concurrent sibling agent() call. Omitted (the default): unchanged from
   * today — the subagent inherits whatever compaction setting the real
   * SettingsManager resolves from disk (§2.1's DEFAULT_COMPACTION_SETTINGS
   * unless the user customized it). `false` is the one case §7 makes the case
   * for: a long, irreducibly serial task (e.g. a build-fix loop) where
   * dropping history is provably not lossy — keep it an explicit opt-in, not a
   * default.
   */
  compaction?: boolean;
  /**
   * What run() does when the captured context signals (agent-context-signals.ts)
   * say this subagent ran out of context — pi's own overflow-recovery
   * compact-and-retry already ran once and still failed, or the terminal turn's
   * stopReason was "length" (docs/plans/subagent-context-pressure.md §6).
   * "throw" (the default): run() throws AGENT_CONTEXT_EXHAUSTED
   * (recoverable:false — see errors.ts). "partial": run() instead RESOLVES with
   * a {@link PartialAgentResult} — whatever assistant text this subagent
   * produced, plus `complete: false`, a REQUIRED field (not an optional flag)
   * so a caller that forgets to check it gets a type error or an obviously
   * shaped value instead of silently treating a cut-off answer as a normal
   * result. The orchestrator (the workflow script), not this subagent, decides
   * what to do with a partial — re-decompose, widen the budget, or accept it.
   */
  onContextExhausted?: "throw" | "partial";
}

/**
 * The opt-in alternative to AGENT_CONTEXT_EXHAUSTED (see `onContextExhausted:
 * "partial"` above). `complete` is REQUIRED and always `false` on this type —
 * deliberately not an optional `incomplete?: true` — so this value can never
 * be mistaken for a complete plain-string/schema result: a caller that reads
 * `.complete` gets `false` here and `true`-or-absent nowhere else, and a
 * caller that doesn't check it at all still receives a shape (`{ complete,
 * reason, text }`) that is never a bare string or the schema's own shape.
 */
export interface PartialAgentResult {
  /** Always false. The required marker — see this type's doc comment. */
  complete: false;
  /** Why run() couldn't finish. Only one reason exists today. */
  reason: "context_exhausted";
  /** Best-effort assistant text produced before context ran out. May be empty. */
  text: string;
}

export type AgentRunResult<
  TSchemaDef extends TSchema | undefined,
  TOnContextExhausted extends "throw" | "partial" = "throw",
> = TOnContextExhausted extends "partial"
  ? (TSchemaDef extends TSchema ? Static<TSchemaDef> : string) | PartialAgentResult
  : TSchemaDef extends TSchema
    ? Static<TSchemaDef>
    : string;
