/**
 * Tests for model spec compose/decompose round-trips with thinking levels.
 *
 * Verifies that:
 * - formatModelSpecWithThinking + splitModelSpecThinking round-trip cleanly
 * - A model id containing a colon is not mistreated as a thinking suffix
 * - Known model specs win over colon parsing when provided
 */
import { describe, expect, it } from "vitest";

import {
  formatModelSpecWithThinking,
  splitModelSpecThinking,
  type ModelThinkingLevel,
} from "./model-spec.ts";

describe("model spec thinking round-trip", () => {
  it("round-trips a spec without thinking", () => {
    const spec = "openrouter/anthropic/claude-haiku-4.5";
    const composed = formatModelSpecWithThinking(spec, undefined);
    const { modelSpec, thinkingLevel } = splitModelSpecThinking(composed);

    expect(modelSpec).toBe(spec);
    expect(thinkingLevel).toBeUndefined();
  });

  it("round-trips a spec with a thinking level", () => {
    const spec = "openrouter/anthropic/claude-haiku-4.5";
    const composed = formatModelSpecWithThinking(spec, "low");
    const { modelSpec, thinkingLevel } = splitModelSpecThinking(composed);

    expect(modelSpec).toBe(spec);
    expect(thinkingLevel).toBe("low");
  });

  it("round-trips all thinking levels", () => {
    const spec = "openrouter/model";
    const levels: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

    for (const level of levels) {
      const composed = formatModelSpecWithThinking(spec, level);
      const { modelSpec, thinkingLevel } = splitModelSpecThinking(composed);

      expect(modelSpec).toBe(spec);
      expect(thinkingLevel).toBe(level);
    }
  });

  it("does not mistake a model id containing a colon for thinking when the full spec is known", () => {
    // Some providers use colon-suffixed model ids (e.g. "gpt-4.5:batch").
    const spec = "provider/model:batch";
    const knownSpecs = [spec];

    const composed = formatModelSpecWithThinking(spec, undefined);
    const { modelSpec, thinkingLevel } = splitModelSpecThinking(composed, knownSpecs);

    expect(modelSpec).toBe(spec);
    expect(thinkingLevel).toBeUndefined();
  });

  it("does not mistake a model id containing a colon for thinking when the full spec + thinking is known", () => {
    // A spec with both a colon in the id AND a thinking suffix.
    const baseSpec = "provider/model:batch";
    const withThinking = formatModelSpecWithThinking(baseSpec, "low");
    expect(withThinking).toBe("provider/model:batch:low");

    // Decompose it with the base spec in the known list.
    const knownSpecs = [baseSpec];
    const { modelSpec, thinkingLevel } = splitModelSpecThinking(withThinking, knownSpecs);

    expect(modelSpec).toBe(baseSpec);
    expect(thinkingLevel).toBe("low");
  });

  it("returns the full string as modelSpec when the suffix is not a valid thinking level", () => {
    const spec = "openrouter/model:unknown";
    const { modelSpec, thinkingLevel } = splitModelSpecThinking(spec);

    expect(modelSpec).toBe(spec);
    expect(thinkingLevel).toBeUndefined();
  });

  it("handles an empty spec", () => {
    const { modelSpec, thinkingLevel } = splitModelSpecThinking("");

    expect(modelSpec).toBe("");
    expect(thinkingLevel).toBeUndefined();
  });

  it("handles undefined", () => {
    const { modelSpec, thinkingLevel } = splitModelSpecThinking(undefined);

    expect(modelSpec).toBe("");
    expect(thinkingLevel).toBeUndefined();
  });

  it("trims whitespace", () => {
    const spec = "  openrouter/model:low  ";
    const { modelSpec, thinkingLevel } = splitModelSpecThinking(spec);

    expect(modelSpec).toBe("openrouter/model");
    expect(thinkingLevel).toBe("low");
  });

  it("preserves a spec with multiple colons when known", () => {
    const spec = "provider/namespace:model:batch";
    const knownSpecs = [spec];

    const { modelSpec, thinkingLevel } = splitModelSpecThinking(spec, knownSpecs);

    expect(modelSpec).toBe(spec);
    expect(thinkingLevel).toBeUndefined();
  });

  it("splits at the LAST colon when the prefix is not known", () => {
    const spec = "provider/namespace:model:low";
    // No known specs provided, so it falls back to colon parsing.
    const { modelSpec, thinkingLevel } = splitModelSpecThinking(spec);

    expect(modelSpec).toBe("provider/namespace:model");
    expect(thinkingLevel).toBe("low");
  });
});
