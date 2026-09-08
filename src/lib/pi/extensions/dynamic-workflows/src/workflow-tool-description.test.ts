import { describe, expect, it } from "vitest";

import { createWorkflowTool } from "./workflow-tool.ts";
import { parseWorkflowScript } from "./workflow.ts";

// This test pins the `script` parameter description's authoring guidance
// against drift, and — because the description embeds a "canonical" example
// script — actually parses that embedded example through the real script
// validator (parseWorkflowScript) so the example can never silently rot into
// an invalid one.

function getScriptDescription(): string {
  const tool = createWorkflowTool();
  const properties = (tool.parameters as { properties: Record<string, unknown> })
    .properties;
  const script = properties.script as { description?: string };
  if (typeof script.description !== "string") {
    throw new Error("expected script parameter to have a string description");
  }
  return script.description;
}

describe("workflow tool `script` description", () => {
  const description = getScriptDescription();

  it("states that meta is the only permitted top-level export", () => {
    expect(description).toContain("meta is the only top-level export allowed");
  });

  it("shows phases nested inside the meta object literal, not as a separate export", () => {
    // Assert `phases:` appears within the same brace-delimited object literal
    // as `name:` — i.e. no `}` closes the object between them.
    const nameIndex = description.indexOf("name: 'short_snake_case'");
    expect(nameIndex).toBeGreaterThan(-1);

    const phasesIndex = description.indexOf("phases:", nameIndex);
    expect(phasesIndex).toBeGreaterThan(nameIndex);

    const between = description.slice(nameIndex, phasesIndex);
    expect(between).not.toContain("}");

    expect(description).toContain("phases is a key inside that same object");
    expect(description).toContain("never a separate export");
  });

  it("tells the author every agent() call needs a short unique label", () => {
    const agentGuidanceIndex = description.indexOf("agent(prompt, opts)");
    expect(agentGuidanceIndex).toBeGreaterThan(-1);

    const nearby = description.slice(
      agentGuidanceIndex,
      agentGuidanceIndex + 400,
    );
    expect(nearby).toContain("label");
    expect(nearby).toContain("unique");
    expect(nearby).toContain("{ label: 'researcher' }");
  });

  it("embeds a minimal valid example that itself parses under the real script rules", () => {
    const marker = "Minimal valid example";
    const exampleIndex = description.indexOf(marker);
    expect(exampleIndex).toBeGreaterThan(-1);

    // The example sentence runs from its "Minimal valid example" marker up to
    // the start of the next sentence in the joined description (the sentences
    // are joined with a single space, and the next one starts with "Use
    // `await workflow").
    const nextSentenceIndex = description.indexOf(
      "Use `await workflow(savedName",
      exampleIndex,
    );
    expect(nextSentenceIndex).toBeGreaterThan(exampleIndex);

    const exampleSentence = description
      .slice(exampleIndex, nextSentenceIndex)
      .trim();

    // Pull the actual code out from after the "):" that ends the label.
    const codeStart = exampleSentence.indexOf("):");
    expect(codeStart).toBeGreaterThan(-1);
    const code = exampleSentence.slice(codeStart + 2).trim();

    // Structural sanity: single export, phases nested, a labeled agent() call.
    // (parseWorkflowScript below is the real check; these are a readable
    // second opinion in case the wrapping ever changes shape.)
    expect(code.match(/^export const meta/m)).not.toBeNull();
    expect(code).toContain("phases:");
    expect(code).toMatch(/agent\([^)]*label:\s*'[^']+'/);
    expect(code.match(/\bexport\b/g)?.length).toBe(1);

    // Real check: the example must actually satisfy the script validator's
    // "meta is the first statement, and the only export" contract. Wrap it in
    // an async function body the same way runWorkflow does, since the example
    // uses a bare `return`.
    const { meta } = parseWorkflowScript(code);
    expect(meta.name).toBe("demo");
    expect(meta.description).toBe("demo workflow");
    expect(meta.phases).toEqual([{ title: "Research" }]);
  });
});
