/**
 * buildSubagentPrompt's part ordering and the structured-output contract it
 * appends. Pure string assembly (agent-prompt.ts's docblock), tested without
 * constructing a session.
 */
import { describe, expect, it } from "vitest";

import { buildSubagentPrompt } from "./agent-prompt.ts";
import type { AgentRunOptions } from "./agent-types.ts";

describe("buildSubagentPrompt", () => {
  it("orders parts as instructions, options.instructions, label line, prompt", () => {
    const options: AgentRunOptions<undefined> = {
      label: "researcher",
      instructions: "Stay within the repo.",
    };

    const result = buildSubagentPrompt(
      "Find every caller of foo().",
      options,
      false,
      "Run instructions apply to every agent.",
    );

    expect(result).toBe(
      [
        "Run instructions apply to every agent.",
        "Stay within the repo.",
        "Task label: researcher",
        "Find every caller of foo().",
      ].join("\n\n"),
    );
  });

  it("drops falsy parts rather than leaving blank gaps", () => {
    const options: AgentRunOptions<undefined> = {};

    const result = buildSubagentPrompt("Just the prompt.", options, false, undefined);

    expect(result).toBe("Just the prompt.");
    expect(result).not.toContain("\n\n\n");
  });

  it("drops the label line when options.label is unset, without leaving a gap", () => {
    const options: AgentRunOptions<undefined> = { instructions: "Be terse." };

    const result = buildSubagentPrompt("Do the thing.", options, false, undefined);

    expect(result).toBe(["Be terse.", "Do the thing."].join("\n\n"));
  });

  it("appends the structured output contract only when structured is true", () => {
    const withoutStructured = buildSubagentPrompt("Prompt.", {}, false, undefined);
    const withStructured = buildSubagentPrompt("Prompt.", {}, true, undefined);

    expect(withoutStructured).not.toContain("structured_output");
    expect(withStructured).toContain("Final output contract:");
    expect(withStructured).toContain("structured_output tool call");
  });

  it("appends the structured output contract last, after prompt and every other part", () => {
    const options: AgentRunOptions<undefined> = {
      label: "schema-agent",
      instructions: "Extract the fields.",
    };

    const result = buildSubagentPrompt(
      "Return the record as JSON.",
      options,
      true,
      "Global instructions.",
    );

    const parts = result.split("\n\n");
    expect(parts[0]).toBe("Global instructions.");
    expect(parts[1]).toBe("Extract the fields.");
    expect(parts[2]).toBe("Task label: schema-agent");
    expect(parts[3]).toBe("Return the record as JSON.");
    expect(parts[4]).toContain("Final output contract:");
    expect(parts).toHaveLength(5);
  });
});
