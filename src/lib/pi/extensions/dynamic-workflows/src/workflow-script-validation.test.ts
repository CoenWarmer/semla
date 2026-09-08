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

// Built-in quality helpers (verify, judgePanel, completenessCheck) generate
// their own agent() labels on the script's behalf. Calling one of them more
// than once in a run must not hard-throw the way a script reusing a literal
// label does — see uniqueRunLabel()/AgentOptions.__internalLabel in
// workflow.ts. retry()/gate() re-invoking a thunk that itself calls agent()
// with the SAME literal label (the common case: the script has no per-attempt
// label to give it) must not throw either — see retryAttemptScope.
describe("repeat-call label collisions in built-in helpers", () => {
  it("verify() called twice in one run does not throw and gets distinct labels", async () => {
    const script = `export const meta = { name: 'demo', description: 'demo' };
await verify('claim one', { reviewers: 1 });
await verify('claim two', { reviewers: 1 });
return null;`;

    const labels: string[] = [];
    await expect(
      runWorkflow(script, {
        agent: stubAgentRunner,
        persistLogs: false,
        onAgentStart: (event) => labels.push(event.label),
      }),
    ).resolves.not.toThrow();
    expect(labels).toEqual(["verify 1", "verify 1 2"]);
  });

  it("judgePanel() called twice in one run does not throw and gets distinct labels", async () => {
    const script = `export const meta = { name: 'demo', description: 'demo' };
await judgePanel(['a'], { judges: 1 });
await judgePanel(['b'], { judges: 1 });
return null;`;

    const labels: string[] = [];
    await expect(
      runWorkflow(script, {
        agent: stubAgentRunner,
        persistLogs: false,
        onAgentStart: (event) => labels.push(event.label),
      }),
    ).resolves.not.toThrow();
    expect(labels).toEqual(["judge 1.1", "judge 1.1 2"]);
  });

  it("a retry() that re-runs the same-labeled agent() does not throw a duplicate-label error", async () => {
    const script = `export const meta = { name: 'demo', description: 'demo' };
let calls = 0;
const result = await retry(async () => {
  calls++;
  return await agent('attempt ' + calls, { label: 'fix build' });
}, { attempts: 3, until: () => calls >= 2 });
return { result, calls };`;

    const labels: string[] = [];
    const { result } = await runWorkflow(script, {
      agent: stubAgentRunner,
      persistLogs: false,
      onAgentStart: (event) => labels.push(event.label),
    });
    // Attempt 1's rejection is via a valid `{ ok: false }` result, not a
    // thrown error, so retry() proceeds to attempt 2 — both attempts call
    // agent() with the SAME literal label 'fix build'.
    expect(result).toEqual({ result: "ok", calls: 2 });
    expect(labels).toEqual(["fix build", "fix build 2"]);
  });

  it("a retry() whose EVERY attempt calls agent() with the same label disambiguates instead of throwing", async () => {
    const script = `export const meta = { name: 'demo', description: 'demo' };
const result = await retry(async (attempt) => {
  return await agent('attempt ' + attempt, { label: 'fix build' });
}, { attempts: 3, until: (r) => false });
return result;`;

    const labels: string[] = [];
    await expect(
      runWorkflow(script, {
        agent: stubAgentRunner,
        persistLogs: false,
        onAgentStart: (event) => labels.push(event.label),
      }),
    ).resolves.not.toThrow();
    expect(labels).toEqual(["fix build", "fix build 2", "fix build 3"]);
  });

  it("a USER script with two same-labeled agent() calls outside retry/gate still throws", async () => {
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
});
