/**
 * Tests for the system-prompt rewrite.
 *
 * The skills section of every prompt here comes from Pi's own
 * `formatSkillsForPrompt`, not from a fixture string, because the thing most
 * likely to break this module is Pi changing how it renders that section. A
 * hand-written fixture would keep passing after such a change; the real
 * formatter fails, which is the point — plan §5 separates skill gating from
 * tool gating precisely because its failure is silent.
 *
 * `buildSystemPrompt` itself is not exported from the package index (only its
 * options type is), so the surrounding prompt is assembled here in the same
 * order `core/system-prompt.ts` assembles it: body, then the skills block,
 * then the cwd line.
 */

import { formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { rewriteSkillsSection } from "./skills-prompt";

function skill(name: string, overrides: Partial<Skill> = {}): Skill {
  return {
    name,
    description: `does ${name}`,
    filePath: `/skills/${name}/SKILL.md`,
    baseDir: `/skills/${name}`,
    sourceInfo: {
      path: `/skills/${name}/SKILL.md`,
      source: "project",
      scope: "project",
      origin: "top-level",
    },
    disableModelInvocation: false,
    ...overrides,
  };
}

const SKILLS = [skill("supabase"), skill("orient"), skill("consolidate")];

function promptWith(skills: readonly Skill[]): string {
  return [
    "You are a coding agent.",
    formatSkillsForPrompt(skills as Skill[]),
    "\nCurrent working directory: /repo",
  ].join("");
}

describe("the delimiters this module depends on", () => {
  it("are still what formatSkillsForPrompt emits", () => {
    // If this fails, Pi changed its skills rendering and rewriteSkillsSection
    // needs updating — better to learn it here than from a prompt that
    // silently kept every skill.
    const formatted = formatSkillsForPrompt(SKILLS as Skill[]);
    expect(formatted).toContain("<available_skills>");
    expect(formatted).toContain("</available_skills>");
    expect(formatted).toContain("<name>supabase</name>");
  });

  it("appear in a real assembled system prompt", () => {
    const prompt = promptWith(SKILLS);
    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("<name>orient</name>");
  });
});

describe("rewriteSkillsSection", () => {
  it("keeps only the approved skills", () => {
    const rewrite = rewriteSkillsSection(promptWith(SKILLS), SKILLS, ["orient"]);

    expect(rewrite.rewritten).toBe(true);
    expect(rewrite.removed.sort()).toEqual(["consolidate", "supabase"]);
    expect(rewrite.systemPrompt).toContain("<name>orient</name>");
    expect(rewrite.systemPrompt).not.toContain("<name>supabase</name>");
    expect(rewrite.systemPrompt).not.toContain("<name>consolidate</name>");
  });

  it("preserves everything outside the skills block", () => {
    const prompt = promptWith(SKILLS);
    const rewrite = rewriteSkillsSection(prompt, SKILLS, ["orient"]);

    // The cwd line follows the skills section; losing it is the kind of
    // collateral damage a delimiter-based cut has to be checked for.
    expect(rewrite.systemPrompt).toContain("Current working directory: /repo");
    const before = prompt.slice(0, prompt.indexOf("<available_skills>"));
    expect(rewrite.systemPrompt.startsWith(before)).toBe(true);
  });

  it("preserves another extension's contribution to the prompt", () => {
    // before_agent_start handlers chain, so the prompt handed over may already
    // have been rewritten. Re-assembling from systemPromptOptions would lose
    // this; cutting one region does not.
    const prompt = `${promptWith(SKILLS)}\n\n<extension_notice>keep me</extension_notice>`;
    const rewrite = rewriteSkillsSection(prompt, SKILLS, ["orient"]);
    expect(rewrite.systemPrompt).toContain("<extension_notice>keep me</extension_notice>");
  });

  it("removes the block and its preamble when no skill survives", () => {
    const rewrite = rewriteSkillsSection(promptWith(SKILLS), SKILLS, []);

    expect(rewrite.rewritten).toBe(true);
    expect(rewrite.systemPrompt).not.toContain("<available_skills>");
    // A preamble announcing skills that are no longer listed would be worse
    // than either extreme.
    expect(rewrite.systemPrompt).not.toContain(
      "The following skills provide specialized instructions",
    );
    expect(rewrite.systemPrompt).toContain("Current working directory: /repo");
  });

  it("does nothing when every skill is approved", () => {
    const prompt = promptWith(SKILLS);
    const rewrite = rewriteSkillsSection(prompt, SKILLS, SKILLS.map((s) => s.name));

    expect(rewrite.rewritten).toBe(false);
    expect(rewrite.systemPrompt).toBe(prompt);
    expect(rewrite.reason).toBe("nothing to remove");
  });

  it("returns the prompt untouched when there is no skills section", () => {
    const rewrite = rewriteSkillsSection("a prompt with no skills", SKILLS, ["orient"]);
    expect(rewrite.rewritten).toBe(false);
    expect(rewrite.systemPrompt).toBe("a prompt with no skills");
    expect(rewrite.reason).toContain("no skills section");
  });

  it("does not count a disableModelInvocation skill as removed", () => {
    // It was never in the rendered block, so reporting it as removed would
    // claim a change that did not happen.
    const hidden = skill("hidden", { disableModelInvocation: true });
    const all = [...SKILLS, hidden];
    const rewrite = rewriteSkillsSection(promptWith(all), all, ["orient"]);
    expect(rewrite.removed).not.toContain("hidden");
  });

  it("survives a description containing XML-significant characters", () => {
    // The block is rebuilt with the real formatter rather than parsed out of
    // the prompt, so escaping round-trips instead of being re-escaped.
    const tricky = skill("tricky", { description: "handles a < b && c > d" });
    const all = [...SKILLS, tricky];
    const rewrite = rewriteSkillsSection(promptWith(all), all, ["tricky"]);

    expect(rewrite.rewritten).toBe(true);
    expect(rewrite.systemPrompt).toContain("&lt;");
    expect(rewrite.systemPrompt).not.toContain("&amp;lt;");
  });
});
