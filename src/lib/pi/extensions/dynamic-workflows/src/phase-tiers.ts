/**
 * Phase tiers: the single place a workflow's cost is declared.
 *
 * Every phase in `meta.phases` MUST name a tier, and every agent that runs
 * inside a phase runs on that phase's tier — a per-call `tier` or `model` does
 * NOT override it. The rule exists because the opposite (a per-call selector
 * winning, and an untagged agent silently falling into the implicit "medium"
 * tier) is what produced a corpus where roughly 100 of 250 recorded agents ran
 * on a tier nobody chose and the configured "small" tier was never used once.
 *
 * Two consequences follow, and both are enforced rather than documented:
 *   - a phase without a tier is a parse-time error (see validateMetaPhaseTiers),
 *     so a bad script costs nothing: it fails before any agent is dispatched;
 *   - an agent() call with no active phase must carry an explicit tier, which
 *     closes the untagged escape hatch the implicit medium default opened.
 *
 * The valid tier names come from the operator's real tier config, not from a
 * list in this file — a tier is only meaningful if `model-tiers.json` maps it
 * to a model. The hardcoded FALLBACK_PHASE_TIER_NAMES is used only when no
 * config file exists at all, and every message that uses it says so, because
 * "small is not a valid tier" is a confusing thing to read on a host whose
 * config the reader assumes exists.
 */

import { WorkflowError, WorkflowErrorCode } from "./errors.ts";
import { type ModelTierConfig, sortedTierNames } from "./model-tier-config.ts";

/** One phase entry as far as tier validation is concerned. */
export interface PhaseTierDeclaration {
  title?: unknown;
  tier?: unknown;
}

/**
 * Tier names assumed when no model-tiers.json exists anywhere. These are the
 * only names `buildDefaultTierConfig` ever produces, so a script written
 * against them keeps working once the operator runs /workflows-models.
 */
export const FALLBACK_PHASE_TIER_NAMES = ["small", "medium", "big"] as const;

/** The tier names a script may use, and where they came from. */
export interface PhaseTierVocabulary {
  names: readonly string[];
  /** False when no tier config was found and the built-in names are in play. */
  fromConfig: boolean;
}

/** Derive the accepted tier names from a (possibly absent) tier config. */
export function phaseTierVocabulary(
  config: ModelTierConfig | null,
): PhaseTierVocabulary {
  if (!config) {
    return { names: [...FALLBACK_PHASE_TIER_NAMES], fromConfig: false };
  }
  return { names: sortedTierNames(config), fromConfig: true };
}

/** Human-readable "valid tiers are ..." clause, naming the source. */
export function describeValidTiers(vocabulary: PhaseTierVocabulary): string {
  const names = vocabulary.names.join(", ");
  return vocabulary.fromConfig
    ? `valid tiers (from model-tiers.json): ${names}`
    : `valid tiers: ${names} (no model-tiers.json was found, so these are the built-in defaults; run /workflows-models to configure them)`;
}

function scriptError(message: string): WorkflowError {
  return new WorkflowError(
    message,
    WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
    { recoverable: false },
  );
}

/**
 * Reject any phase that does not declare a usable tier. Called from
 * parseWorkflowScript, so this is the earliest possible point: no agent has
 * been dispatched and no token has been spent.
 */
export function validateMetaPhaseTiers(
  phases: readonly PhaseTierDeclaration[] | undefined,
  vocabulary: PhaseTierVocabulary,
): void {
  if (!phases) return;
  for (const [index, phase] of phases.entries()) {
    const title = typeof phase.title === "string" ? phase.title : "";
    const named = title.trim() ? `"${title}"` : `#${index + 1}`;
    const tier = phase.tier;
    if (tier === undefined) {
      throw scriptError(
        `meta phase ${named} does not declare a tier. Every phase must declare one, e.g. { title: ${JSON.stringify(title || named)}, tier: ${JSON.stringify(vocabulary.names[0] ?? "medium")} }: a phase costs what it declares, and an agent that needs a different model belongs in its own phase. ${describeValidTiers(vocabulary)}.`,
      );
    }
    if (typeof tier !== "string" || !tier.trim()) {
      throw scriptError(
        `meta phase ${named} has a non-string tier (${JSON.stringify(tier)}); a tier must be one of the configured names. ${describeValidTiers(vocabulary)}.`,
      );
    }
    if (!vocabulary.names.includes(tier)) {
      throw scriptError(
        `meta phase ${named} declares an unknown tier "${tier}". ${describeValidTiers(vocabulary)}.`,
      );
    }
  }
}

/**
 * Map declared phase title -> declared tier. Built once per run; the runtime
 * looks the assigned phase up here rather than re-reading meta.
 */
export function buildPhaseTierMap(
  phases: readonly PhaseTierDeclaration[] | undefined,
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const phase of phases ?? []) {
    if (typeof phase.title === "string" && typeof phase.tier === "string") {
      map.set(phase.title, phase.tier);
    }
  }
  return map;
}

/** A per-call selector that a phase tier is about to override. */
export interface IgnoredSelector {
  kind: "tier" | "model";
  value: string;
}

/**
 * The warning emitted when a phase tier overrides a per-call selector. Not an
 * error: the phase wins and the run continues. But it is never silent, because
 * silent precedence is the defect this whole mechanism replaces.
 */
export function formatPhaseTierOverride(info: {
  phase: string;
  phaseTier: string;
  label: string;
  ignored: IgnoredSelector;
}): string {
  return (
    `phase "${info.phase}" declares tier "${info.phaseTier}", which overrides ` +
    `${info.ignored.kind} "${info.ignored.value}" requested by agent "${info.label}". ` +
    `The phase tier always wins; move this agent into its own phase if it needs a different model.`
  );
}

/**
 * The same warning for an agent running outside any phase: its own explicit
 * tier decides the model, so a `model` it also passed is ignored.
 */
export function formatCallTierOverride(info: {
  tier: string;
  label: string;
  ignored: IgnoredSelector;
}): string {
  return (
    `agent "${info.label}" runs outside any phase on its explicit tier "${info.tier}", ` +
    `which overrides ${info.ignored.kind} "${info.ignored.value}". ` +
    `A tier always decides the model; drop the ${info.ignored.kind} or configure the tier instead.`
  );
}

/**
 * An agent() call outside any phase must name its own tier. Thrown, not
 * defaulted: the implicit "medium" default is exactly the escape hatch this
 * rule closes.
 */
export function requireCallTier(
  tier: unknown,
  label: string,
  vocabulary: PhaseTierVocabulary,
): string {
  if (typeof tier === "string" && tier.trim()) {
    if (!vocabulary.names.includes(tier)) {
      throw scriptError(
        `agent "${label}" requests an unknown tier "${tier}". ${describeValidTiers(vocabulary)}.`,
      );
    }
    return tier;
  }
  throw scriptError(
    `agent "${label}" runs outside any declared phase, so it must pass an explicit tier, e.g. { label: ${JSON.stringify(label)}, tier: ${JSON.stringify(vocabulary.names[0] ?? "medium")} } — or call phase('Title') first, using a phase declared with a tier in meta.phases. ${describeValidTiers(vocabulary)}.`,
  );
}

/**
 * A phase title that was entered at runtime but never declared in meta.phases
 * has no tier, so there is nothing to charge the work to. Hard error, naming
 * the fix.
 */
export function undeclaredPhaseError(
  phase: string,
  label: string,
  vocabulary: PhaseTierVocabulary,
): WorkflowError {
  return scriptError(
    `agent "${label}" runs in phase "${phase}", which is not declared in meta.phases, so it has no tier. Declare it, e.g. phases: [{ title: ${JSON.stringify(phase)}, tier: ${JSON.stringify(vocabulary.names[0] ?? "medium")} }]. ${describeValidTiers(vocabulary)}.`,
  );
}
