/**
 * Fix 4 (second-export rejection) and fix 5 (agent() label enforcement) both
 * throw before any real agent work happens, so these are exercised directly
 * against parseWorkflowScript() and runWorkflow() with a minimal injected
 * WorkflowAgentRunner (WorkflowRunOptions.agent) that never touches a real
 * subagent session — mirroring the injection point WorkflowManagerOptions.agent
 * documents as a test-only escape hatch (see agent.ts).
 */
import { describe, expect, it } from "vitest";

import type { WorkflowAgentRunner } from "./workflow.ts";
import { parseWorkflowScript, runWorkflow } from "./workflow.ts";

// Resolves to a fixed string regardless of prompt/options — good enough for
// scripts that never inspect the result.
const stubAgentRunner: WorkflowAgentRunner = {
  async run() {
    return "ok";
  },
};

describe("parseWorkflowScript: second top-level export", () => {
  it("names the second export in the error message", () => {
    const script = `export const meta = { name: 'demo', description: 'demo' };
export const phases = [{ title: 'Research' }];
return null;`;

    expect(() => parseWorkflowScript(script)).toThrowError(
      'Unexpected second export "phases": workflow scripts may only export meta. Move it inside meta, e.g. export const meta = { name, description, phases: [...] }.',
    );
  });

  it("still parses a script with only the meta export", () => {
    const script = `export const meta = { name: 'demo', description: 'demo' };
return 42;`;

    const { meta, body } = parseWorkflowScript(script);
    expect(meta).toEqual({ name: "demo", description: "demo" });
    expect(body.trim()).toBe("return 42;");
  });
});

describe("agent() label enforcement", () => {
  it("throws a fix-naming message when opts.label is missing", async () => {
    const script = `export const meta = { name: 'demo', description: 'demo' };
await agent('do something');
return null;`;

    await expect(
      runWorkflow(script, { agent: stubAgentRunner, persistLogs: false }),
    ).rejects.toThrow(
      "agent() call #1 is missing a label; add opts.label (e.g. { label: 'researcher' })",
    );
  });

  it("throws a fix-naming message when two agent() calls share a label", async () => {
    const script = `export const meta = { name: 'demo', description: 'demo' };
await agent('first', { label: 'researcher' });
await agent('second', { label: 'researcher' });
return null;`;

    await expect(
      runWorkflow(script, { agent: stubAgentRunner, persistLogs: false }),
    ).rejects.toThrow(
      'agent() label "researcher" is already used in this run; give each agent() call a unique label',
    );
  });

  it("does not throw when every agent() call has a distinct label", async () => {
    const script = `export const meta = { name: 'demo', description: 'demo' };
const a = await agent('first', { label: 'researcher' });
const b = await agent('second', { label: 'writer' });
return { a, b };`;

    const { result } = await runWorkflow(script, {
      agent: stubAgentRunner,
      persistLogs: false,
    });
    expect(result).toEqual({ a: "ok", b: "ok" });
  });
});
