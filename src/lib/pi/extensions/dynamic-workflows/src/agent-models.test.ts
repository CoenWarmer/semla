/**
 * resolveAgentModelSpec's tier/model precedence, and resolveSubagentModel's
 * #131 asymmetry between an EXPLICIT model/tier that fails to resolve
 * (throws) and an UNTAGGED agent's implicit default tier failing (degrades
 * to the session default). Both functions take an injected config loader and
 * registry per their docblock, so none of this touches the process-wide
 * fallback registry (`ensureFallbackRegistry`/`fallbackRegistry`).
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { isWorkflowError, WorkflowErrorCode } from "./errors.ts";
import {
  resolveAgentModelSpec,
  resolveSubagentModel,
  type SubagentModelRequest,
} from "./agent-models.ts";
import type { ModelTierConfig } from "./model-tier-config.ts";

/** Minimal Model<Api> stub — only the fields resolveModelSpecWithThinking reads. */
function makeModel(provider: string, id: string): Model<Api> {
  return {
    id,
    name: id,
    api: "anthropic-messages",
    provider,
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100000,
    maxTokens: 4096,
  };
}

/**
 * Fake registry exposing exactly what resolveModelSpecWithThinking reads off
 * it: getAll() (required) and hasConfiguredAuth() (optional, used only for
 * the aggregator-vs-native-provider disambiguation). Not a real ModelRegistry
 * — cast at the call boundary, same as the SDK-agnostic Pick<> the source
 * itself declares.
 */
function fakeRegistry(models: Model<Api>[]): ModelRegistry {
  return {
    getAll: () => models,
    hasConfiguredAuth: () => true,
  } as unknown as ModelRegistry;
}

describe("resolveAgentModelSpec", () => {
  it("an explicit model wins over tier, even when a tier is also set", () => {
    const loadConfig = vi.fn<() => ModelTierConfig | null>(() => ({
      tiers: { medium: "openrouter/other" },
    }));

    const result = resolveAgentModelSpec(
      { model: "openrouter/explicit", tier: "medium" },
      "openrouter/main",
      loadConfig,
    );

    expect(result).toBe("openrouter/explicit");
    // Explicit model short-circuits before the config is even consulted.
    expect(loadConfig).not.toHaveBeenCalled();
  });

  it("resolves a tier through the injected config loader", () => {
    const loadConfig = () => ({ tiers: { big: "openrouter/big-model" } });

    const result = resolveAgentModelSpec(
      { tier: "big" },
      "openrouter/main",
      loadConfig,
    );

    expect(result).toBe("openrouter/big-model");
  });

  it("a tier with no entry in the config falls back to mainModel and reports the no-op once", () => {
    const loadConfig = () => ({ tiers: { medium: "openrouter/medium" } });
    const onTierWithoutConfig = vi.fn();

    const result = resolveAgentModelSpec(
      { tier: "small" },
      "openrouter/main",
      loadConfig,
      onTierWithoutConfig,
    );

    expect(result).toBe("openrouter/main");
    // The config DOES exist — only the requested tier is missing from it — so
    // this is not the "no config at all" case onTierWithoutConfig exists for.
    expect(onTierWithoutConfig).not.toHaveBeenCalled();
  });

  it("a tier requested with no config file at all falls back to mainModel and calls onTierWithoutConfig once", () => {
    const loadConfig = () => null;
    const onTierWithoutConfig = vi.fn();

    const result = resolveAgentModelSpec(
      { tier: "small" },
      "openrouter/main",
      loadConfig,
      onTierWithoutConfig,
    );

    expect(result).toBe("openrouter/main");
    expect(onTierWithoutConfig).toHaveBeenCalledTimes(1);
    expect(onTierWithoutConfig).toHaveBeenCalledWith("small");
  });

  it("an untagged agent defaults to the configured medium tier", () => {
    const loadConfig = () => ({ tiers: { medium: "openrouter/medium-default" } });

    const result = resolveAgentModelSpec({}, "openrouter/main", loadConfig);

    expect(result).toBe("openrouter/medium-default");
  });

  it("an untagged agent with no config at all returns undefined, deferring to the session default", () => {
    const loadConfig = () => null;

    const result = resolveAgentModelSpec({}, "openrouter/main", loadConfig);

    expect(result).toBeUndefined();
  });
});

describe("resolveSubagentModel (#131 asymmetry)", () => {
  const noopOnDefaultTierUnavailable = () => {};

  it("throws MODEL_NOT_FOUND (recoverable:false) when an EXPLICIT model cannot be resolved", () => {
    // A provider not in the registry at all: a same-provider spec (e.g.
    // "openrouter/does-not-exist") would silently resolve via model-spec.ts's
    // custom-model-id fallback for that provider, which is not the condition
    // under test here.
    const registry = fakeRegistry([makeModel("openrouter", "known-model")]);
    const request: SubagentModelRequest = { model: "unknown-provider/nope", label: "researcher" };

    try {
      resolveSubagentModel(request, registry, undefined, () => null, noopOnDefaultTierUnavailable);
      expect.unreachable("expected resolveSubagentModel to throw");
    } catch (error) {
      expect(isWorkflowError(error)).toBe(true);
      if (!isWorkflowError(error)) throw error;
      expect(error.code).toBe(WorkflowErrorCode.MODEL_NOT_FOUND);
      expect(error.recoverable).toBe(false);
      expect(error.agentLabel).toBe("researcher");
    }
  });

  it("throws MODEL_NOT_FOUND when an EXPLICIT tier resolves to an unavailable spec, naming both the tier and the resolved spec", () => {
    const registry = fakeRegistry([makeModel("openrouter", "known-model")]);
    const loadTierConfig = () => ({ tiers: { small: "unknown-provider/unavailable-small" } });
    const request: SubagentModelRequest = { tier: "small", label: "builder" };

    try {
      resolveSubagentModel(request, registry, undefined, loadTierConfig, noopOnDefaultTierUnavailable);
      expect.unreachable("expected resolveSubagentModel to throw");
    } catch (error) {
      expect(isWorkflowError(error)).toBe(true);
      if (!isWorkflowError(error)) throw error;
      expect(error.code).toBe(WorkflowErrorCode.MODEL_NOT_FOUND);
      expect(error.recoverable).toBe(false);
      expect(error.message).toContain("small");
      expect(error.message).toContain("unknown-provider/unavailable-small");
    }
  });

  it("an UNTAGGED agent whose implicit medium tier is unavailable does NOT throw — returns {} and reports the fallback", () => {
    const registry = fakeRegistry([makeModel("openrouter", "known-model")]);
    const loadTierConfig = () => ({ tiers: { medium: "unknown-provider/unavailable-medium" } });
    const onDefaultTierUnavailable = vi.fn();

    const result = resolveSubagentModel(
      {},
      registry,
      undefined,
      loadTierConfig,
      onDefaultTierUnavailable,
    );

    expect(result).toEqual({});
    expect(onDefaultTierUnavailable).toHaveBeenCalledTimes(1);
    expect(onDefaultTierUnavailable).toHaveBeenCalledWith({
      tier: "medium",
      requestedSpec: "unknown-provider/unavailable-medium",
    });
  });

  it("calls onModelResolved with the canonical spec only on success", () => {
    const registry = fakeRegistry([makeModel("openrouter", "known-model")]);
    const onModelResolved = vi.fn();
    const request: SubagentModelRequest = {
      model: "openrouter/known-model",
      onModelResolved,
    };

    const result = resolveSubagentModel(request, registry, undefined, () => null, noopOnDefaultTierUnavailable);

    expect(result.model).toBeDefined();
    expect(onModelResolved).toHaveBeenCalledTimes(1);
    expect(onModelResolved).toHaveBeenCalledWith("openrouter/known-model");
  });

  it("does not call onModelResolved when resolution fails", () => {
    const registry = fakeRegistry([makeModel("openrouter", "known-model")]);
    const onModelResolved = vi.fn();
    const request: SubagentModelRequest = {
      model: "unknown-provider/nope",
      onModelResolved,
    };

    expect(() =>
      resolveSubagentModel(request, registry, undefined, () => null, noopOnDefaultTierUnavailable),
    ).toThrow();
    expect(onModelResolved).not.toHaveBeenCalled();
  });
});
