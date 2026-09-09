/**
 * Model resolution for workflow subagents: which concrete model spec a run
 * uses, and the registry it is resolved against.
 *
 * Split out of agent.ts because this is the whole of the tier/model precedence
 * rule plus the process-wide fallback registry that backs it — module state
 * (`fallbackRuntimePromise`, the warn-once flag) that has nothing to do with
 * running a turn, and that agent.ts's run loop only calls into.
 *
 * The `model-tier-config.ts` import is part of a pre-existing cycle: that
 * module calls listAvailableModels() for its own tier-ranking display. Both
 * directions are function calls made after module init, never top-level reads.
 *
 * `resolveAgentModelSpec` and `resolveSubagentModel` are pure given their
 * injected config loader and registry, and are tested that way
 * (agent-models.test.ts). The rest of this file is not: `fallbackRegistry`,
 * `warnedNoRuntime` and `warnedTierUnconfigured` are process-wide and have no
 * reset hook, so their once-only behavior is observable only on a module's
 * first use in a process.
 */

import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import {
  type CreateAgentSessionOptions,
  getAgentDir,
  ModelRegistry,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { ensurePiAgentDirIsolated } from "../../../agent-dir.ts";
import { WorkflowError, WorkflowErrorCode } from "./errors.ts";
import {
  canonicalModelSpec,
  resolveModelSpecWithThinking,
} from "./model-spec.ts";
import {
  formatTierFallbackNotice,
  loadModelTierConfig,
  type ModelTierConfig,
  type RankableModel,
  resolveTierModel,
} from "./model-tier-config.ts";

/**
 * Resolve which concrete model spec a subagent should use. Precedence, most
 * specific first:
 *   1. options.model — an explicit per-agent model (also carries agentType /
 *      phase model, which the workflow layer folds into options.model).
 *   2. options.tier  — resolved via the model-tiers config, falling back to the
 *      session's main model when the tier has no configured entry.
 *   3. DEFAULT TIER — when neither is set but the user has a model-tiers config,
 *      untagged agents default to the "medium" tier so a configured tier set
 *      actually affects the whole workflow (not just agents the script tagged).
 *      Fresh-install medium == the session model, so this is a no-op until the
 *      user customizes tiers via /workflows-models.
 * Returns undefined when nothing applies, so the session default is used.
 *
 * `loadConfig` is injectable for testing; it defaults to reading from disk.
 *
 * BRANCH 3 IS UNREACHABLE FROM THE ONLY PRODUCTION CALL CHAIN, but is kept
 * (docblock and body both) rather than deleted, because "only production
 * caller" is not "only caller": `resolveAgentModelSpec` is exported and
 * exercised directly, with no tier and no model, by `agent-models.test.ts`
 * (see "an untagged agent defaults to the configured medium tier" and its
 * neighbors) — a legitimate second world, testing this function's behavior
 * in isolation from any one caller's invariant, that a docblock describing
 * only the workflow-reachable branches would misrepresent.
 *
 * Within the actual production call chain — `resolveSubagentModel` (below),
 * called only from `WorkflowAgent.run()` (agent.ts), constructed only inside
 * `runWorkflow()` (workflow.ts); `options.agent` is a test-only injection
 * point, never supplied by any production caller — branch 3 cannot execute.
 * Since ad62fe5 made every phase's tier mandatory, and made every
 * out-of-phase agent's own tier mandatory too, `workflow.ts`'s dispatch
 * always resolves an `effectiveTier` before calling down into this function
 * (from the phase's declared tier, or from `requireCallTier`, which throws
 * rather than returning undefined) — so `options.tier` is always set by the
 * time a workflow-originated call reaches here, and branch 2 always applies
 * instead. `modelSpec` is also hard-coded to `undefined` at the one workflow
 * dispatch site that calls into this chain (workflow.ts, agentImpl), so
 * branch 1 is likewise never taken from that path; both branches exist for
 * `resolveSubagentModel`'s own callers-in-isolation (tests) and for any
 * future non-workflow caller, not because either is reachable today from
 * `runWorkflow()`.
 */
export function resolveAgentModelSpec(
  options: { model?: string; tier?: string },
  mainModel: string | undefined,
  loadConfig: () => ModelTierConfig | null = loadModelTierConfig,
  onTierWithoutConfig?: (tier: string) => void,
): string | undefined {
  if (options.model) return options.model;
  const config = loadConfig();
  if (options.tier) {
    // Tier requested but unconfigured → it silently falls back to mainModel.
    // Let the caller surface that (once) so the no-op is discoverable.
    if (!config) onTierWithoutConfig?.(options.tier);
    return (
      (config ? resolveTierModel(options.tier, config) : undefined) ?? mainModel
    );
  }
  // Untagged agent: default to the configured medium tier when one exists.
  if (config) {
    const medium = resolveTierModel("medium", config);
    if (medium) return medium;
  }
  return undefined;
}

// pi >= 0.80.8: ModelRegistry is a sync facade over an async-created ModelRuntime
// (AuthStorage/ModelRegistry.create are gone). The disk-backed fallback is built
// lazily; sync callers see [] until it resolves and real specs on later reads.
let fallbackRuntimePromise: Promise<ModelRuntime> | undefined;
let fallbackRegistry: ModelRegistry | undefined;

export function ensureFallbackRegistry(): Promise<ModelRegistry> {
  if (!fallbackRuntimePromise) {
    // Defensive: see ensurePiAgentDirIsolated()'s docblock — a process where
    // instrumentation.ts's register() never ran would otherwise resolve
    // getAgentDir() below against the host's ~/.pi/agent instead of Semla's own.
    ensurePiAgentDirIsolated();
    const dir = getAgentDir();
    // Same auth.json/models.json createAgentSession uses by default, so a model
    // resolved here carries valid credentials.
    fallbackRuntimePromise = (async () => {
      const runtime = await ModelRuntime.create({
        authPath: join(dir, "auth.json"),
        modelsPath: join(dir, "models.json"),
      });
      // Warm the availability snapshot so the facade's sync getAvailable() is
      // populated immediately after this promise resolves.
      await runtime.getAvailable().catch(() => {});
      return runtime;
    })();
    // Don't cache a rejection: a transient failure (e.g. auth.json lock) would
    // otherwise wedge the fallback for the rest of the process.
    fallbackRuntimePromise.catch(() => {
      fallbackRuntimePromise = undefined;
    });
  }
  return fallbackRuntimePromise.then((runtime) => {
    fallbackRegistry ??= new ModelRegistry(runtime);
    return fallbackRegistry;
  });
}

let warnedNoRuntime = false;

/**
 * The ModelRuntime behind a registry facade. pi's ModelRegistry does not expose
 * its runtime publicly, so reach into the private field (stable since 0.80.8);
 * subagent sessions need it to share the host session's exact catalog and auth
 * (createAgentSession takes modelRuntime, not a registry, since 0.80.8).
 *
 * Exported so the test suite can pin this pi-internals contract: the cast means
 * neither tsc nor mock-based tests would notice pi renaming the field, and the
 * runtime consequence is silent (subagents fall back to a default runtime and
 * extension-registered providers vanish from routing).
 */
export function runtimeOf(registry: ModelRegistry): ModelRuntime | undefined {
  const runtime = (registry as unknown as { runtime?: ModelRuntime }).runtime;
  if (!runtime && !warnedNoRuntime) {
    warnedNoRuntime = true;
    console.warn(
      "[workflow] ModelRegistry no longer carries a private `runtime` field (pi internals changed); subagents fall back to a default-built runtime and may miss extension-registered providers",
    );
  }
  return runtime;
}

/**
 * List the user's currently available models (those with auth configured) with
 * the minimal fields tier ranking needs: canonical spec, output price, and
 * context window. This is the single place the SDK `Model` is projected into
 * the SDK-agnostic `RankableModel`. Best-effort: returns [] if the registry
 * can't be built (or while the disk-backed fallback is still initializing).
 */
export function listAvailableModels(registry?: ModelRegistry): RankableModel[] {
  try {
    const modelRegistry = registry ?? fallbackRegistry;
    if (!modelRegistry) {
      // Kick off the async fallback build; this call reports [] and later
      // calls (e.g. the tool's lazy promptGuidelines re-reads) see real specs.
      void ensureFallbackRegistry().catch(() => {});
      return [];
    }
    return modelRegistry.getAvailable().map((model) => ({
      spec: canonicalModelSpec(model),
      costOutput: model.cost?.output,
      contextWindow: model.contextWindow,
    }));
  } catch {
    return [];
  }
}

/**
 * List the user's currently available models as `provider/modelId` specs. Used
 * to tell the workflow author which models it may route agents to. Best-effort:
 * returns [] if the registry can't be built.
 */
export function listAvailableModelSpecs(registry?: ModelRegistry): string[] {
  return listAvailableModels(registry).map((model) => model.spec);
}

/**
 * Emitted at most once per process: when an agent asks for a tier but no
 * model-tiers.json exists, the tier silently falls back to the session model.
 * Surface that once (with the mapping the user would get by configuring) so the
 * no-op is discoverable. Diagnostics only — never lets a failure break a run.
 */
let warnedTierUnconfigured = false;
export function warnTierUnconfiguredOnce(
  mainModel: string | undefined,
  registry: ModelRegistry,
): void {
  if (warnedTierUnconfigured) return;
  warnedTierUnconfigured = true;
  try {
    console.warn(
      formatTierFallbackNotice(mainModel, listAvailableModels(registry)),
    );
  } catch {
    // best-effort diagnostic
  }
}

/** What a subagent session needs to pin its model: both are undefined when the session default applies. */
export interface ResolvedSubagentModel {
  model?: Model<any>;
  thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
}

/** The parts of an agent() call this resolution reads. */
export interface SubagentModelRequest {
  model?: string;
  tier?: string;
  label?: string;
  onModelResolved?: (modelId: string) => void;
  onModelFallback?: (info: { tier: string; requestedSpec: string }) => void;
}

/**
 * Resolve an agent() call to a concrete Model, or to nothing when the session
 * default should stand.
 *
 * Specs use Pi CLI-style parsing, including an optional :thinking suffix such
 * as gpt-5.5:xhigh. A given-but-unresolved spec's behavior is asymmetric by
 * design (#131):
 *   - options.model or options.tier was explicitly set by the script (or by
 *     workflow.ts's phase-based routing, which only ever supplies options.model
 *     when the user configured that phase) → throw MODEL_NOT_FOUND naming the
 *     source. Resolution is deterministic, so retrying the same spec is
 *     pointless (recoverable:false), and a silent substitution would otherwise
 *     run real API calls against a different (or unauthenticated) model while
 *     the caller believes its pin/tier was honored.
 *   - neither was set: the agent is UNTAGGED and only got routed through the
 *     implicit default "medium" tier because *some other* agent's tier is
 *     configured (see resolveAgentModelSpec). This agent never asked for that
 *     model, so a broken default tier degrades to the session default instead
 *     of failing every untagged agent in the run — but the degrade still needs
 *     to be loud, which is what onDefaultTierUnavailable is for. The caller
 *     owns that flag because it is per-run state, not per-resolution.
 */
export function resolveSubagentModel(
  options: SubagentModelRequest,
  modelRegistry: ModelRegistry,
  mainModel: string | undefined,
  loadTierConfig: () => ModelTierConfig | null,
  onDefaultTierUnavailable: (info: {
    tier: string;
    requestedSpec: string;
  }) => void,
): ResolvedSubagentModel {
  // Resolve the model spec (explicit model > tier > session default). This
  // composes with phase-based routing in workflow.ts, which only supplies
  // options.model when a phase pattern matches — so an explicit model wins.
  const modelSpec = resolveAgentModelSpec(options, mainModel, loadTierConfig, () =>
    warnTierUnconfiguredOnce(mainModel, modelRegistry),
  );
  if (!modelSpec) return {};

  const resolved = resolveModelSpecWithThinking(modelSpec, modelRegistry);
  if (resolved.warning) console.warn(`[workflow] ${resolved.warning}`);

  if (!resolved.model) {
    if (options.model || options.tier) {
      // The resolver's error already names the spec and the remedy; the tier
      // branch swaps in its own message so the config source is named too.
      const message = options.model
        ? (resolved.error ??
          `Model "${modelSpec}" not found. Use /workflows-models to choose an available model.`)
        : `tier "${options.tier}" from model-tiers.json resolves to "${modelSpec}", which is not available. Use /workflows-models to choose an available model.`;
      throw new WorkflowError(message, WorkflowErrorCode.MODEL_NOT_FOUND, {
        recoverable: false,
        agentLabel: options.label,
      });
    }
    onDefaultTierUnavailable({ tier: "medium", requestedSpec: modelSpec });
    return {};
  }

  options.onModelResolved?.(
    resolved.resolvedSpec ?? canonicalModelSpec(resolved.model),
  );
  return { model: resolved.model, thinkingLevel: resolved.thinkingLevel };
}
