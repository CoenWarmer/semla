import { describe, expect, it } from "vitest";

import { explainFunctionPrompt } from "./review-prompts.ts";

const base = {
  endLine: 32,
  path: "src/lib/code-map/call-graph.ts",
  project: "semla",
  startLine: 30,
  symbol: "Pipeline.run",
};

describe("explainFunctionPrompt", () => {
  it("names the symbol, the full path and the line range", () => {
    // The range is what stops the agent guessing between same-named functions.
    const prompt = explainFunctionPrompt(base);

    expect(prompt).toContain("`Pipeline.run`");
    expect(prompt).toContain("`semla/src/lib/code-map/call-graph.ts`");
    expect(prompt).toContain("lines 30-32");
  });

  it("says 'line' rather than 'lines' for a one-line declaration", () => {
    // Arrow functions assigned to a const are the common shape here.
    const prompt = explainFunctionPrompt({ ...base, endLine: 21, startLine: 21 });

    expect(prompt).toContain("line 21");
    expect(prompt).not.toContain("lines 21");
  });

  it("asks the agent to read the file rather than pasting the body", () => {
    // A pasted body goes stale the moment the operator edits, and the panel's
    // other half is an editor.
    expect(explainFunctionPrompt(base)).toContain("Read the file");
  });

  it("mentions the review when the turn changed this file", () => {
    const prompt = explainFunctionPrompt({ ...base, changed: true });

    expect(prompt).toContain("reviewing a change");
    expect(prompt).toContain("wrong or surprising");
  });

  it("asks the general question for a file the turn did not touch", () => {
    const prompt = explainFunctionPrompt({ ...base, changed: false });

    expect(prompt).toContain("what calls it and what it calls");
    expect(prompt).not.toContain("reviewing a change");
  });
});
