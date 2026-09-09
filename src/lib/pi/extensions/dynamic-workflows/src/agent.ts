/**
 * The workflow subagent runner: one `WorkflowAgent` per run, one `run()` call
 * per subagent, each building a fresh pi AgentSession and returning that
 * agent's text, its schema-validated structured output, or a partial result.
 *
 * Everything auxiliary lives in siblings so this file stays the run loop:
 *   - agent-types.ts     — the option/result types the workflow layer programs against
 *   - agent-models.ts    — model spec + registry resolution
 *   - agent-session.ts   — tool set, transcript persistence, shared resource loader
 *   - agent-prompt.ts    — the prompt (and schema output contract) a turn is given
 *   - agent-output.ts    — reading a finished turn: text, provider limits, context exhaustion
 *   - agent-observers.ts — abort/history/context-signal plumbing and its teardown
 *
 * Their public surface is re-exported below, so `./agent.ts` remains the single
 * import site every existing caller already uses. agent-observers.ts is the
 * exception: `run()` is its only caller, and nothing outside this file has any
 * reason to attach observers to a session it did not create.
 */

import {
  type CreateAgentSessionOptions,
  createAgentSession,
  createCodingTools,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { ensurePiAgentDirIsolated } from "../../../agent-dir.ts";
import { recordStopReason } from "./agent-context-signals.ts";
import { attachRunObservers } from "./agent-observers.ts";
import {
  ensureFallbackRegistry,
  resolveSubagentModel,
  runtimeOf,
} from "./agent-models.ts";
import {
  finalAssistantText,
  isContextExhausted,
  lastAssistantError,
  lastAssistantText,
  resolveStructuredOutput,
  throwIfContextExhausted,
  throwIfProviderLimit,
  usageFromStats,
} from "./agent-output.ts";
import { buildSubagentPrompt } from "./agent-prompt.ts";
import {
  buildSharedResourceLoader,
  buildSubagentTools,
  createSubagentSessionManager,
  resolvePersistAgentSessions,
  subagentExcludedTools,
} from "./agent-session.ts";
import type {
  AgentRunOptions,
  AgentRunResult,
  WorkflowAgentOptions,
} from "./agent-types.ts";
import { WorkflowError, WorkflowErrorCode } from "./errors.ts";
import { loadModelTierConfig, type ModelTierConfig } from "./model-tier-config.ts";
import type { StructuredOutputCapture } from "./structured-output.ts";

// `./agent.ts` stays the single import site for the whole runner surface.
export type {
  AgentRunOptions,
  AgentRunResult,
  AgentUsage,
  PartialAgentResult,
  StructuredSession,
  WorkflowAgentOptions,
} from "./agent-types.ts";
export {
  listAvailableModels,
  listAvailableModelSpecs,
  resolveAgentModelSpec,
  runtimeOf,
} from "./agent-models.ts";
export {
  extractValidated,
  finalAssistantText,
  isContextExhausted,
  lastAssistantError,
  lastAssistantText,
  resolveStructuredOutput,
  throwIfContextExhausted,
  throwIfProviderLimit,
  usageFromStats,
} from "./agent-output.ts";
export { buildSubagentPrompt } from "./agent-prompt.ts";
export {
  DEFAULT_EXCLUDED_SUBAGENT_TOOLS,
  mergeRelocatedCodingTools,
  subagentExcludedTools,
} from "./agent-session.ts";

export class WorkflowAgent {
  private readonly cwd: string;
  private readonly baseTools: ToolDefinition[];
  /** Extra subagent tool-name denylist, merged with the always-on defaults. */
  private readonly excludeTools: string[];
  private readonly sessionOptions: Partial<CreateAgentSessionOptions>;
  private readonly persistAgentSessions: boolean;
  private readonly instructions?: string;
  private readonly mainModel?: string;
  /** Shared registry from the host session, when provided. */
  private readonly sharedRegistry?: ModelRegistry;
  /** Lazily built once; shares the SDK's agentDir/auth so resolved models are authed. */
  private registry?: ModelRegistry;
  /**
   * Memoized model-tiers.json snapshot, boxed so a legitimately-null config
   * (file absent/invalid) is distinguishable from "not loaded yet". See
   * loadTierConfig() below for why this is scoped per-instance.
   */
  private tierConfigBox?: { value: ModelTierConfig | null };
  /**
   * Shared resource loader for every subagent of this run, built once. See
   * getSharedResourceLoader — this is the #109 memory mitigation.
   */
  private sharedResourceLoaderPromise?: Promise<DefaultResourceLoader>;
  /**
   * Emitted at most once per instance (~= once per run, see the class-level
   * lifetime note above): the untagged/default "medium" tier resolved to a
   * model spec that isn't available. Deliberately per-instance rather than a
   * MODEL_NOT_FOUND throw — an untagged agent never asked for that specific
   * model, so a broken default tier shouldn't fail every untagged agent in the
   * run. See onModelFallback below for the (still-loud) degrade path.
   */
  private warnedDefaultTierUnavailable = false;

  constructor(options: WorkflowAgentOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.baseTools = options.tools?.length ? options.tools : createCodingTools(this.cwd);
    this.excludeTools = options.excludeTools ?? [];
    this.sessionOptions = options.session ?? {};
    // Default true: subagent sessions persist to disk unless a settings file
    // or an explicit caller override turns this off (see WorkflowAgentOptions
    // and workflow-settings.ts's persistAgentSessions doc for the full chain).
    this.persistAgentSessions = resolvePersistAgentSessions(options.persistAgentSessions);
    this.instructions = options.instructions;
    this.mainModel = options.mainModel;
    this.sharedRegistry = options.modelRegistry;
  }

  /**
   * The resource loader shared by every subagent of this run, built once (#109).
   * See buildSharedResourceLoader in agent-session.ts for what sharing buys and
   * what `noExtensions: true` costs; the memo lives here because a WorkflowAgent
   * instance's lifetime is exactly one run.
   */
  private getSharedResourceLoader(
    agentDir: string,
  ): Promise<DefaultResourceLoader> {
    if (!this.sharedResourceLoaderPromise) {
      this.sharedResourceLoaderPromise = buildSharedResourceLoader(
        this.cwd,
        agentDir,
      ).catch((err: unknown) => {
        // Don't let a transient build failure (e.g. EMFILE during reload's disk
        // I/O) poison every subagent AND every retry of this run — clear the memo
        // so the next caller rebuilds instead of replaying the same rejection.
        this.sharedResourceLoaderPromise = undefined;
        throw err;
      });
    }
    return this.sharedResourceLoaderPromise;
  }

  /**
   * Resolve the registry for a run: an explicit per-run registry wins, then the
   * constructor's shared registry, then a lazily-built disk registry (shared
   * across calls once built). Async because pi >= 0.80.8 builds registries from
   * an async-created ModelRuntime.
   */
  private async getRegistry(
    perRunRegistry?: ModelRegistry,
  ): Promise<ModelRegistry> {
    if (perRunRegistry) {
      return perRunRegistry;
    }
    if (this.sharedRegistry) {
      return this.sharedRegistry;
    }
    if (!this.registry) {
      this.registry = await ensureFallbackRegistry();
    }
    return this.registry;
  }

  /**
   * Read+parse ~/.pi/workflows/model-tiers.json at most once for this
   * instance's lifetime, instead of on every run() call. `resolveAgentModelSpec`
   * previously received `loadModelTierConfig` directly (sync existsSync +
   * readFileSync + JSON.parse from disk), which it calls unconditionally for
   * any agent without an explicit options.model — so a large fan-out did N
   * redundant synchronous disk reads that blocked the event loop and stalled
   * concurrent agents' I/O.
   *
   * `runWorkflow()` constructs a fresh `WorkflowAgent` per run (see
   * `new WorkflowAgent(options)` in workflow.ts, unless a caller injects its
   * own `options.agent` runner — a test-only escape hatch per
   * WorkflowManagerOptions.agent's doc comment), so a WorkflowAgent instance's
   * lifetime is one run in production. Memoizing on `this` therefore has the
   * same scope and lifetime as the agentRegistry snapshot workflow.ts already
   * takes once per run "for determinism" — the config file isn't expected to
   * change mid-run, and two different runs (= two different WorkflowAgent
   * instances) each get their own fresh read of whatever is on disk at the
   * time, so this does not leak stale config across runs or break tests that
   * construct fresh agents with different configs.
   *
   * `loader` is injectable for tests (defaults to the real disk read); it is
   * only ever consulted once, on the first call, regardless of what is passed
   * on later calls.
   */
  private loadTierConfig(
    loader: () => ModelTierConfig | null = () =>
      // Passing the cwd is what lets a repository ship its own tiers; without
      // it only the home file is ever read, and the override is dead config.
      loadModelTierConfig({ cwd: this.cwd }),
  ): ModelTierConfig | null {
    if (!this.tierConfigBox) {
      this.tierConfigBox = { value: loader() };
    }
    return this.tierConfigBox.value;
  }

  async run<
    TSchemaDef extends TSchema | undefined = undefined,
    TOnContextExhausted extends "throw" | "partial" = "throw",
  >(
    prompt: string,
    options: AgentRunOptions<TSchemaDef> & {
      onContextExhausted?: TOnContextExhausted;
    } = {},
  ): Promise<AgentRunResult<TSchemaDef, TOnContextExhausted>> {
    const capture: StructuredOutputCapture<any> = {
      called: false,
      value: undefined,
    };
    const runCwd = options.cwd ?? this.cwd;
    const customTools = buildSubagentTools(
      options,
      this.baseTools,
      runCwd,
      this.cwd,
      capture,
    );

    // Per-run modelRegistry wins over the constructor's shared registry, then
    // the lazily-built disk fallback. Used for tier diagnostics, model
    // resolution, and the subagent session's runtime below.
    const modelRegistry = await this.getRegistry(options.modelRegistry);

    const { model: resolvedModel, thinkingLevel: resolvedThinkingLevel } =
      resolveSubagentModel(
        options,
        modelRegistry,
        this.mainModel,
        () => this.loadTierConfig(),
        (info) => {
          if (this.warnedDefaultTierUnavailable) return;
          this.warnedDefaultTierUnavailable = true;
          options.onModelFallback?.(info);
        },
      );

    // Defensive: see ensurePiAgentDirIsolated()'s docblock — a process where
    // instrumentation.ts's register() never ran would otherwise resolve
    // getAgentDir() below against the host's ~/.pi/agent instead of Semla's own.
    ensurePiAgentDirIsolated();
    const agentDir = getAgentDir();
    // The runtime behind the resolved registry, handed to the subagent session
    // below so it shares the host session's exact catalog and auth.
    const modelRuntime = runtimeOf(modelRegistry);
    // Key persisted sessions by the runner's project cwd (this.cwd), NOT the
    // per-call runCwd: agents working in short-lived git worktrees should still
    // group under the project's session dir instead of scattering across
    // temporary worktree paths.
    // sessionDir is left at its default (PI_SESSION_DIR) so this subagent's
    // transcript lands in the exact directory the main session's files use —
    // see createSubagentSessionManager's docblock.
    const sessionManager = createSubagentSessionManager(
      this.cwd,
      this.persistAgentSessions,
    );
    // Use real SettingsManager to inherit user's default provider/model settings.
    // SettingsManager.inMemory() doesn't load ~/.pi/settings.json, so subagents
    // would fall back to the first available model (e.g. openai-codex) which may
    // not have valid auth, causing silent empty responses.
    const settingsManager = SettingsManager.create(this.cwd, agentDir);
    // Per-agent compaction opt-in/out (docs/plans/subagent-context-pressure.md
    // §7 / AgentRunOptions.compaction). applyOverrides merges into this
    // SettingsManager's already-resolved settings snapshot in memory and never
    // calls save() — unlike setCompactionEnabled/setAutoCompactionEnabled, it
    // cannot write to this run's settings.json (or race a concurrent sibling
    // agent() call's own fresh SettingsManager instance, since each run() call
    // builds its own). Omitted: no override, so getCompactionEnabled() falls
    // through to whatever §2.1's real settings resolve to — unchanged default.
    if (options.compaction !== undefined) {
      settingsManager.applyOverrides({
        compaction: { enabled: options.compaction },
      });
    }
    const { session } = await createAgentSession({
      cwd: runCwd,
      agentDir,
      sessionManager,
      settingsManager,
      customTools,
      // Shared per-run loader with no host extensions (#109) — see
      // getSharedResourceLoader. An injected resourceLoader (tests / embedders)
      // wins and skips the shared build entirely; the ...this.sessionOptions
      // spread below re-applies the same injected value harmlessly.
      resourceLoader:
        this.sessionOptions.resourceLoader ??
        (await this.getSharedResourceLoader(agentDir)),
      // Share the resolved registry's ModelRuntime (catalog + auth, including
      // extension-registered providers) with the subagent session. pi >= 0.80.8
      // takes modelRuntime here; the old modelRegistry option is gone.
      ...(modelRuntime ? { modelRuntime } : {}),
      ...this.sessionOptions,
      // Per-call model/thinking wins over any sessionOptions defaults.
      ...(resolvedModel ? { model: resolvedModel } : {}),
      ...(resolvedThinkingLevel
        ? { thinkingLevel: resolvedThinkingLevel }
        : {}),
      // Deny recursive-orchestration tools in the subagent (#107). Placed after
      // the sessionOptions spread so it always applies; folds in any denylist
      // the caller set on sessionOptions rather than dropping it.
      excludeTools: subagentExcludedTools(
        this.excludeTools,
        this.sessionOptions.excludeTools,
      ),
    });

    // Name the persisted session so it's identifiable in session pickers.
    // Skip when an injected session.sessionManager override won (tests/embedders).
    if (
      this.persistAgentSessions &&
      !this.sessionOptions.sessionManager &&
      options.sessionName
    ) {
      try {
        sessionManager.appendSessionInfo(options.sessionName);
      } catch {
        // Naming is best-effort; never fail the run over it.
      }
    }

    // Diagnostics (abort forwarding, history, context-pressure signals) and the
    // teardown that must run on both paths — see agent-observers.ts.
    const { contextSignals, settle } = attachRunObservers(session, options);
    try {
      if (options.signal?.aborted) throw new Error("Subagent was aborted");
      await session.prompt(
        buildSubagentPrompt(
          prompt,
          options as AgentRunOptions<any>,
          Boolean(options.schema),
          this.instructions,
        ),
      );

      if (options.signal?.aborted) throw new Error("Subagent was aborted");

      // The SDK buries a provider usage/quota limit in the assistant message rather
      // than throwing; detect it here (before the schema/empty-text branches) so it
      // is classified as a recoverable checkpoint, not a SCHEMA_NONCOMPLIANCE failure
      // (schema path) or a silent empty-output null (non-schema path).
      throwIfProviderLimit(session.messages, options.label);

      // Same idea as throwIfProviderLimit above, for a different terminal condition
      // the SDK never throws: run out of context. Record the terminal stopReason
      // into contextSignals now (not just in the finally block below) so this
      // check — and the same contextSignals.stopReason a caller reads via
      // onContextSignals — see the same value. See §6 of
      // docs/plans/subagent-context-pressure.md and this file's
      // throwIfContextExhausted/isContextExhausted.
      recordStopReason(
        contextSignals,
        lastAssistantError(session.messages)?.stopReason,
      );
      if (isContextExhausted(contextSignals)) {
        if (options.onContextExhausted === "partial") {
          const partialText = options.schema
            ? lastAssistantText(session.messages)
            : finalAssistantText(session.messages);
          return {
            complete: false,
            reason: "context_exhausted",
            text: partialText,
          } as AgentRunResult<TSchemaDef, TOnContextExhausted>;
        }
        throwIfContextExhausted(contextSignals, options.label);
      }

      if (options.schema) {
        return (await resolveStructuredOutput(
          session,
          capture,
          options.schema,
          options,
          lastAssistantText,
        )) as AgentRunResult<TSchemaDef, TOnContextExhausted>;
      }

      // Unstructured result: require assistant text AFTER the last tool result.
      // Text emitted before it is stale progress (the agent's last real action was
      // a tool call) — accepting it would report an incomplete run as successful
      // and suppress the AGENT_EMPTY_OUTPUT retry (#111).
      const text = finalAssistantText(session.messages);
      if (!text.trim()) {
        throw new WorkflowError(
          "Subagent produced no assistant output",
          WorkflowErrorCode.AGENT_EMPTY_OUTPUT,
          {
            recoverable: true,
            agentLabel: options.label,
          },
        );
      }
      return text as AgentRunResult<TSchemaDef, TOnContextExhausted>;
    } finally {
      settle();
    }
  }
}
