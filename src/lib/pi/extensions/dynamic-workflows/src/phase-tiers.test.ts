/**
 * The phase-tier contract, driven through the real production entry points:
 * parseWorkflowScript() for the parse-time gate and runWorkflow() with an
 * injected WorkflowAgentRunner for the dispatch-time precedence. Nothing here
 * re-implements the rules — the assertions read what the runtime did (the tier
 * each agent was actually dispatched with, and the run's own log lines).
 *
 * `tierConfig` is pinned on every call so the accepted tier names come from a
 * fixture rather than from whatever model-tiers.json the machine running the
 * test happens to have in ~/.pi or .pi.
 */
import { describe, expect, it } from "vitest";

import type { TSchema } from "typebox";

import type { AgentRunOptions } from "./agent.ts";
import type { ModelTierConfig } from "./model-tier-config.ts";
import type { WorkflowAgentRunner } from "./workflow.ts";
import { parseWorkflowScript, runWorkflow } from "./workflow.ts";

const TIER_CONFIG: ModelTierConfig = {
  tiers: {
    small: "openrouter/small-model",
    medium: "openrouter/medium-model",
    big: "openrouter/big-model",
  },
};

/**
 * Records the (label, tier, model) each agent was actually dispatched with —
 * i.e. exactly what WorkflowAgent.run() would resolve a model from. This is
 * the observation point for "the phase tier won".
 */
function recordingRunner(): {
  runner: WorkflowAgentRunner;
  calls: Array<{ label?: string; tier?: string; model?: string }>;
} {
  const calls: Array<{ label?: string; tier?: string; model?: string }> = [];
  return {
    calls,
    runner: {
      async run(_prompt: string, options?: AgentRunOptions<TSchema>) {
        calls.push({
          label: options?.label,
          tier: options?.tier,
          model: options?.model,
        });
        return "ok";
      },
    },
  };
}

describe("parseWorkflowScript: every phase must declare a tier", () => {
  it("rejects a phase with no tier, naming the phase and the valid tiers", () => {
    const script = `export const meta = { name: 'demo', description: 'demo', phases: [{ title: 'Research' }] };
return null;`;

    expect(() =>
      parseWorkflowScript(script, { tierConfig: TIER_CONFIG }),
    ).toThrowError(
      /meta phase "Research" does not declare a tier\.[\s\S]*valid tiers \(from model-tiers\.json\): small, medium, big\./,
    );
  });

  it("names the offending phase even when a sibling phase is tiered", () => {
    const script = `export const meta = { name: 'demo', description: 'demo', phases: [{ title: 'Research', tier: 'small' }, { title: 'Write' }] };
return null;`;

    expect(() =>
      parseWorkflowScript(script, { tierConfig: TIER_CONFIG }),
    ).toThrowError(/meta phase "Write" does not declare a tier/);
  });

  it("rejects an unknown tier name, listing the configured names", () => {
    const script = `export const meta = { name: 'demo', description: 'demo', phases: [{ title: 'Research', tier: 'gigantic' }] };
return null;`;

    expect(() =>
      parseWorkflowScript(script, { tierConfig: TIER_CONFIG }),
    ).toThrowError(
      'meta phase "Research" declares an unknown tier "gigantic". valid tiers (from model-tiers.json): small, medium, big.',
    );
  });

  it("says so when no tier config exists and the built-in names are in play", () => {
    const script = `export const meta = { name: 'demo', description: 'demo', phases: [{ title: 'Research' }] };
return null;`;

    expect(() =>
      parseWorkflowScript(script, { tierConfig: null }),
    ).toThrowError(
      /valid tiers: small, medium, big \(no model-tiers\.json was found, so these are the built-in defaults; run \/workflows-models to configure them\)/,
    );
  });

  it("accepts a fully tiered phase list", () => {
    const script = `export const meta = { name: 'demo', description: 'demo', phases: [{ title: 'Research', tier: 'small' }] };
return null;`;

    const { meta } = parseWorkflowScript(script, { tierConfig: TIER_CONFIG });
    expect(meta.phases).toEqual([{ title: "Research", tier: "small" }]);
  });
});

describe("phase tier wins at dispatch", () => {
  it("dispatches every agent in a phase on that phase's tier", async () => {
    const script = `export const meta = { name: 'demo', description: 'demo', phases: [{ title: 'Research', tier: 'small' }, { title: 'Write', tier: 'big' }] };
phase('Research');
await agent('a', { label: 'one' });
await agent('b', { label: 'two' });
phase('Write');
await agent('c', { label: 'three' });
return null;`;

    const { runner, calls } = recordingRunner();
    await runWorkflow(script, {
      agent: runner,
      persistLogs: false,
      tierConfig: TIER_CONFIG,
    });

    expect(calls).toEqual([
      { label: "one", tier: "small", model: undefined },
      { label: "two", tier: "small", model: undefined },
      { label: "three", tier: "big", model: undefined },
    ]);
  });

  it("overrides a per-call tier and logs the override", async () => {
    const script = `export const meta = { name: 'demo', description: 'demo', phases: [{ title: 'Research', tier: 'small' }] };
phase('Research');
await agent('a', { label: 'one', tier: 'big' });
return null;`;

    const { runner, calls } = recordingRunner();
    const { logs } = await runWorkflow(script, {
      agent: runner,
      persistLogs: false,
      tierConfig: TIER_CONFIG,
    });

    expect(calls).toEqual([{ label: "one", tier: "small", model: undefined }]);
    expect(logs).toContain(
      'phase "Research" declares tier "small", which overrides tier "big" requested by agent "one". ' +
        "The phase tier always wins; move this agent into its own phase if it needs a different model.",
    );
  });

  it("overrides a per-call model and logs the override", async () => {
    const script = `export const meta = { name: 'demo', description: 'demo', phases: [{ title: 'Research', tier: 'medium' }] };
phase('Research');
await agent('a', { label: 'one', model: 'openrouter/pinned-model' });
return null;`;

    const { runner, calls } = recordingRunner();
    const { logs } = await runWorkflow(script, {
      agent: runner,
      persistLogs: false,
      tierConfig: TIER_CONFIG,
    });

    expect(calls).toEqual([{ label: "one", tier: "medium", model: undefined }]);
    expect(logs).toContain(
      'phase "Research" declares tier "medium", which overrides model "openrouter/pinned-model" requested by agent "one". ' +
        "The phase tier always wins; move this agent into its own phase if it needs a different model.",
    );
  });

  it("overrides a phase's own model route in favour of its tier", async () => {
    const script = `export const meta = { name: 'demo', description: 'demo', phases: [{ title: 'Research', tier: 'small', model: 'openrouter/route-model' }] };
phase('Research');
await agent('a', { label: 'one' });
return null;`;

    const { runner, calls } = recordingRunner();
    const { logs } = await runWorkflow(script, {
      agent: runner,
      persistLogs: false,
      tierConfig: TIER_CONFIG,
    });

    expect(calls).toEqual([{ label: "one", tier: "small", model: undefined }]);
    expect(
      logs.some((line) => line.includes('model "openrouter/route-model"')),
    ).toBe(true);
  });

  it("an agent whose explicit phase was never declared is a hard error", async () => {
    const script = `export const meta = { name: 'demo', description: 'demo', phases: [{ title: 'Research', tier: 'small' }] };
await agent('a', { label: 'one', phase: 'Undeclared' });
return null;`;

    const { runner } = recordingRunner();
    await expect(
      runWorkflow(script, {
        agent: runner,
        persistLogs: false,
        tierConfig: TIER_CONFIG,
      }),
    ).rejects.toThrow(
      /agent "one" runs in phase "Undeclared", which is not declared in meta\.phases, so it has no tier\./,
    );
  });
});

describe("an agent with no active phase must name its own tier", () => {
  it("is a hard error when the tier is missing", async () => {
    const script = `export const meta = { name: 'demo', description: 'demo' };
await agent('a', { label: 'lonely' });
return null;`;

    const { runner } = recordingRunner();
    await expect(
      runWorkflow(script, {
        agent: runner,
        persistLogs: false,
        tierConfig: TIER_CONFIG,
      }),
    ).rejects.toThrow(
      /agent "lonely" runs outside any declared phase, so it must pass an explicit tier[\s\S]*valid tiers \(from model-tiers\.json\): small, medium, big\./,
    );
  });

  it("runs on the explicit tier when one is given", async () => {
    const script = `export const meta = { name: 'demo', description: 'demo' };
await agent('a', { label: 'lonely', tier: 'big' });
return null;`;

    const { runner, calls } = recordingRunner();
    await runWorkflow(script, {
      agent: runner,
      persistLogs: false,
      tierConfig: TIER_CONFIG,
    });

    expect(calls).toEqual([{ label: "lonely", tier: "big", model: undefined }]);
  });

  it("rejects an unknown tier on the call, naming the valid names", async () => {
    const script = `export const meta = { name: 'demo', description: 'demo' };
await agent('a', { label: 'lonely', tier: 'gigantic' });
return null;`;

    const { runner } = recordingRunner();
    await expect(
      runWorkflow(script, {
        agent: runner,
        persistLogs: false,
        tierConfig: TIER_CONFIG,
      }),
    ).rejects.toThrow(
      'agent "lonely" requests an unknown tier "gigantic". valid tiers (from model-tiers.json): small, medium, big.',
    );
  });

  it("logs the override when an out-of-phase call passes both a tier and a model", async () => {
    const script = `export const meta = { name: 'demo', description: 'demo' };
await agent('a', { label: 'lonely', tier: 'small', model: 'openrouter/pinned-model' });
return null;`;

    const { runner, calls } = recordingRunner();
    const { logs } = await runWorkflow(script, {
      agent: runner,
      persistLogs: false,
      tierConfig: TIER_CONFIG,
    });

    expect(calls).toEqual([
      { label: "lonely", tier: "small", model: undefined },
    ]);
    expect(logs).toContain(
      'agent "lonely" runs outside any phase on its explicit tier "small", which overrides model "openrouter/pinned-model". ' +
        "A tier always decides the model; drop the model or configure the tier instead.",
    );
  });
});

describe("a script with phases has no untiered escape hatch", () => {
  it("charges an agent before the first phase() call to the first declared phase", async () => {
    // runWorkflow seeds state.currentPhase from meta.phases[0], so a call
    // before any phase() still lands in a declared, tiered phase rather than
    // in an implicit default.
    const script = `export const meta = { name: 'demo', description: 'demo', phases: [{ title: 'Research', tier: 'small' }] };
await agent('a', { label: 'early' });
return null;`;

    const { runner, calls } = recordingRunner();
    await runWorkflow(script, {
      agent: runner,
      persistLogs: false,
      tierConfig: TIER_CONFIG,
    });

    expect(calls).toEqual([{ label: "early", tier: "small", model: undefined }]);
  });
});
