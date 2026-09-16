/**
 * `deriveSkillSignals` against an injected `SkillModelCaller`, never a real
 * model — the extraction contract (strict JSON, verbatim quotes, one call per
 * skill) is what's under test, not any particular provider's behaviour.
 */

import { describe, expect, it } from "vitest";

import { deriveSkillSignals, type SkillModelCaller, type SkillSource } from "./skill-signals";

function skill(name: string, content = "body"): SkillSource {
  return { content, filePath: `/skills/${name}/SKILL.md`, name };
}

function callerReturning(text: string): SkillModelCaller {
  return async () => ({ ok: true, text });
}

describe("deriveSkillSignals", () => {
  it("emits a suggested-by-skill signal with the quote as evidence", async () => {
    const text = JSON.stringify({
      findings: [
        {
          category: "dev-server",
          quote: "Probe /_next/mcp (tools/list) against the running dev server.",
          summary: "probe /_next/mcp tools/list",
        },
      ],
    });

    const { signals, warnings } = await deriveSkillSignals(
      [skill("next-dev-loop")],
      callerReturning(text),
    );

    expect(warnings).toEqual([]);
    expect(signals).toEqual([
      {
        category: "dev-server",
        detail: "next-dev-loop",
        evidence:
          '"next-dev-loop" skill: probe /_next/mcp tools/list ("Probe /_next/mcp (tools/list) against the running dev server.")',
        state: "suggested-by-skill",
      },
    ]);
  });

  it("emits nothing when the model finds no verification step", async () => {
    const { signals, warnings } = await deriveSkillSignals(
      [skill("find-skills")],
      callerReturning('{"findings":[]}'),
    );

    expect(signals).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("drops a finding with no category match rather than guessing one", async () => {
    const text = JSON.stringify({
      findings: [{ category: "not-a-real-category", quote: "x", summary: "y" }],
    });

    const { signals } = await deriveSkillSignals([skill("odd")], callerReturning(text));

    expect(signals).toEqual([]);
  });

  it("drops a finding with an empty quote rather than fabricating evidence", async () => {
    const text = JSON.stringify({ findings: [{ category: "lint", quote: "  ", summary: "y" }] });

    const { signals } = await deriveSkillSignals([skill("odd")], callerReturning(text));

    expect(signals).toEqual([]);
  });

  it("accepts a response wrapped in a fenced code block", async () => {
    const inner = JSON.stringify({
      findings: [{ category: "mcp", quote: "Call tools/list.", summary: "list tools" }],
    });
    const fenced = `\`\`\`json\n${inner}\n\`\`\``;

    const { signals } = await deriveSkillSignals([skill("fenced")], callerReturning(fenced));

    expect(signals).toHaveLength(1);
    expect(signals[0]?.category).toBe("mcp");
  });

  it("warns rather than throwing when the model call fails", async () => {
    const failing: SkillModelCaller = async () => ({ ok: false, reason: "no configured auth" });

    const { signals, warnings } = await deriveSkillSignals([skill("broken")], failing);

    expect(signals).toEqual([]);
    expect(warnings).toEqual([
      'Could not read "broken" for verification signals: no configured auth',
    ]);
  });

  it("warns rather than throwing when the model reply is not valid JSON", async () => {
    const { signals, warnings } = await deriveSkillSignals(
      [skill("prose")],
      callerReturning("Sure, here's a summary of the skill: it verifies things."),
    );

    expect(signals).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Could not read "prose"');
  });

  it("calls once per skill and keeps results independent", async () => {
    const calls: string[] = [];
    const caller: SkillModelCaller = async (skill) => {
      calls.push(skill.name);
      if (skill.name === "a") {
        return {
          ok: true,
          text: JSON.stringify({ findings: [{ category: "lint", quote: "run lint", summary: "lint" }] }),
        };
      }
      return { ok: true, text: '{"findings":[]}' };
    };

    const { signals } = await deriveSkillSignals([skill("a"), skill("b")], caller);

    expect(calls).toEqual(["a", "b"]);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.detail).toBe("a");
  });
});
