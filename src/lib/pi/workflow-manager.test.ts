import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, test } from "vitest";

import { WorkflowManager } from "./extensions/dynamic-workflows/src/workflow-manager.ts";

// A mock agent that resolves immediately — no real Pi session is started.
// oxlint-disable-next-line typescript/no-explicit-any
const mockAgent = { run: async () => "mock result" } as any;

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "semla-wf-test-"));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeManager() {
  return new WorkflowManager({ cwd: tmpDir, agent: mockAgent });
}

// Deep-clone a snapshot so intermediate states are not lost to later mutations.
// The manager mutates the same snapshot object in place, so capturing a
// reference would only ever reflect the final state.
function cloneSnapshot(s: object): object {
  return JSON.parse(JSON.stringify(s));
}

// ---------------------------------------------------------------------------
// Foreground (runSync) — the path that streams progress via SSE
// ---------------------------------------------------------------------------

test("foreground run: initial snapshot carries runId", async () => {
  const manager = makeManager();
  let firstSnapshot: { runId?: string } | undefined;

  await manager.runSync(
    `export const meta = { name: "runid-check", description: "test workflow", phases: [] }
     return {}`,
    undefined,
    {
      onProgress: (s: object) => {
        if (!firstSnapshot) firstSnapshot = cloneSnapshot(s) as { runId?: string };
      },
    },
  );

  assert.ok(firstSnapshot?.runId, "snapshot should have a runId from the start");
});

test("foreground run: agent appears as 'running' before it completes", async () => {
  const manager = makeManager();
  const snapshots: Array<{ agents: Array<{ label: string; status: string }> }> = [];

  await manager.runSync(
    `export const meta = { name: "agent-status", description: "test workflow", phases: [] }
     await agent("do the thing", { label: "worker" })
     return {}`,
    undefined,
    {
      onProgress: (s: object) => {
        snapshots.push(cloneSnapshot(s) as (typeof snapshots)[number]);
      },
    },
  );

  const runningSnap = snapshots.find((s) =>
    s.agents.some((a) => a.label === "worker" && a.status === "running"),
  );
  const doneSnap = snapshots.find((s) =>
    s.agents.some((a) => a.label === "worker" && a.status === "done"),
  );

  assert.ok(runningSnap, "snapshot should show agent as 'running' when it starts");
  assert.ok(doneSnap, "snapshot should show agent as 'done' after it completes");
});

test("foreground run: each spawned agent gets its own entry in the snapshot", async () => {
  const manager = makeManager();

  await manager.runSync(
    `export const meta = { name: "multi-agent", description: "test workflow", phases: [] }
     await agent("task A", { label: "agent-a" })
     await agent("task B", { label: "agent-b" })
     return {}`,
    undefined,
    {},
  );

  const runId = manager.listLiveRuns()[0].runId;
  const snapshot = manager.getSnapshot(runId);
  assert.equal(snapshot?.agents.length, 2, "snapshot should contain both agents");
  assert.ok(
    snapshot.agents.every((a: { status: string }) => a.status === "done"),
    "both agents should be done after the run completes",
  );
});

test("foreground run: parallel agents both appear in snapshot", async () => {
  const manager = makeManager();

  await manager.runSync(
    `export const meta = { name: "parallel-agents", description: "test workflow", phases: [] }
     await parallel([
       () => agent("alpha", { label: "alpha" }),
       () => agent("beta",  { label: "beta"  }),
     ])
     return {}`,
    undefined,
    {},
  );

  const runId = manager.listLiveRuns()[0].runId;
  const snapshot = manager.getSnapshot(runId);
  assert.equal(snapshot?.agents.length, 2, "both parallel agents should appear");
  const labels = snapshot.agents.map((a: { label: string }) => a.label).sort();
  assert.deepEqual(labels, ["alpha", "beta"]);
});

test("foreground run: agent label and phase are recorded in snapshot", async () => {
  const manager = makeManager();

  await manager.runSync(
    `export const meta = { name: "labeled", description: "test workflow", phases: [{ title: "Research" }] }
     await agent("research task", { label: "researcher", phase: "Research" })
     return {}`,
    undefined,
    {},
  );

  const runId = manager.listLiveRuns()[0].runId;
  const snapshot = manager.getSnapshot(runId);
  const agent = snapshot?.agents[0];
  assert.equal(agent?.label, "researcher");
  assert.equal(agent?.phase, "Research");
});

// ---------------------------------------------------------------------------
// Background (startInBackground) — the path where Semla polls via getSnapshot
// ---------------------------------------------------------------------------

test("background run: registers manager in globalThis after startInBackground", async () => {
  const manager = makeManager();

  const REGISTRY_KEY = Symbol.for("semla.workflow.managers");
  const registry = (globalThis as Record<symbol, Map<string, WeakRef<object>> | undefined>)[REGISTRY_KEY];
  if (registry) registry.clear();

  const { runId, promise } = manager.startInBackground(
    `export const meta = { name: "bg-reg", description: "test workflow", phases: [] }
     await agent("bg task", { label: "bg-worker" })
     return {}`,
  );

  const reg = (globalThis as Record<symbol, Map<string, WeakRef<object>> | undefined>)[REGISTRY_KEY];
  assert.ok(reg?.has(runId), "manager should be in globalThis registry after startInBackground");
  assert.ok(reg?.get(runId)?.deref() === manager, "WeakRef should point to the same manager instance");

  await promise;
});

test("background run: getSnapshot reflects agents after completion", async () => {
  const manager = makeManager();

  const { runId, promise } = manager.startInBackground(
    `export const meta = { name: "bg-snapshot", description: "test workflow", phases: [] }
     await agent("bg work", { label: "bg-agent" })
     return {}`,
  );

  await promise;

  const snapshot = manager.getSnapshot(runId);
  assert.ok(snapshot, "getSnapshot should return data after run completes");
  assert.equal(snapshot.agents.length, 1);
  assert.equal(snapshot.agents[0].label, "bg-agent");
  assert.equal(snapshot.agents[0].status, "done");
});

// ---------------------------------------------------------------------------
// resume() run-option precedence: an option explicitly supplied on the
// RESUMING call must win over the persisted value; an omitted option must
// keep inheriting it. See workflow-manager.ts's resume() doc comment.
// ---------------------------------------------------------------------------

// A two-agent script whose second call only runs if the agent cap allows it.
const TWO_AGENT_SCRIPT = `export const meta = { name: "cap-check", description: "test workflow", phases: [] }
     await agent("first", { label: "one" })
     await agent("second", { label: "two" })
     return {}`;

test("resume with a higher maxAgents enforces the NEW limit, not the old one", async () => {
  const manager = makeManager();

  // Start capped at 1 agent: the second agent() call breaches the cap and the
  // run fails with AGENT_LIMIT_EXCEEDED — this is the exact reported bug
  // ("Agent limit exceeded (6)... Use maxAgents option to increase the limit").
  const { runId, promise } = manager.startInBackground(TWO_AGENT_SCRIPT, undefined, {
    maxAgents: 1,
  });
  await assert.rejects(promise, /Agent limit exceeded \(1\)/);

  const persistedAfterFailure = manager.getPersistence().load(runId);
  assert.equal(persistedAfterFailure?.status, "failed");
  assert.equal(persistedAfterFailure?.maxAgents, 1, "the failed run's cap of 1 must be what's on disk");

  // Resume with an explicitly higher cap: this must win over the persisted 1,
  // so both agents complete this time. Reverting the fix (resume() ignoring
  // opts.maxAgents) makes this call reject again with the same "(1)" message.
  const resumed = await manager.resume(runId, { maxAgents: 5 });
  assert.ok(resumed, "resume should succeed");

  const finished = await waitForTerminal(manager, runId);
  assert.equal(finished.status, "completed", "raising maxAgents on resume must let the second agent run");
  assert.equal(finished.agents.length, 2);
  assert.deepEqual(
    finished.agents.map((a) => a.label).sort(),
    ["one", "two"],
  );
});

test("resume without maxAgents still inherits the prior run's value", async () => {
  const manager = makeManager();

  const { runId, promise } = manager.startInBackground(TWO_AGENT_SCRIPT, undefined, {
    maxAgents: 1,
  });
  await assert.rejects(promise, /Agent limit exceeded \(1\)/);

  // No maxAgents on this resume call: the persisted cap of 1 must still apply,
  // so the second agent breaches it again — inheritance must not break.
  const resumed = await manager.resume(runId, {});
  assert.ok(resumed, "resume should succeed");

  const finished = await waitForTerminal(manager, runId);
  assert.equal(finished.status, "failed", "omitting maxAgents on resume must keep enforcing the persisted cap");
  assert.match(finished.error ?? "", /Agent limit exceeded \(1\)/);
});

test("resume with a higher tokenBudget enforces the NEW budget, not the old one", async () => {
  const manager = makeManager();

  // A tiny starting budget: the first agent's estimated token cost alone
  // exhausts it, so the second agent() call throws TOKEN_BUDGET_EXHAUSTED.
  const { runId, promise } = manager.startInBackground(TWO_AGENT_SCRIPT, undefined, {
    tokenBudget: 1,
  });
  await assert.rejects(promise, /token budget exhausted/);

  const persistedAfterFailure = manager.getPersistence().load(runId);
  assert.equal(persistedAfterFailure?.tokenBudget, 1);

  // A generous explicit budget on resume must win over the persisted 1.
  const resumed = await manager.resume(runId, { tokenBudget: 1_000_000 });
  assert.ok(resumed, "resume should succeed");

  const finished = await waitForTerminal(manager, runId);
  assert.equal(finished.status, "completed", "raising tokenBudget on resume must let the second agent run");
  assert.equal(finished.agents.length, 2);
});

test("resume without tokenBudget still inherits the prior run's value", async () => {
  const manager = makeManager();

  const { runId, promise } = manager.startInBackground(TWO_AGENT_SCRIPT, undefined, {
    tokenBudget: 1,
  });
  await assert.rejects(promise, /token budget exhausted/);

  const resumed = await manager.resume(runId, {});
  assert.ok(resumed, "resume should succeed");

  const finished = await waitForTerminal(manager, runId);
  assert.equal(finished.status, "failed", "omitting tokenBudget on resume must keep enforcing the persisted budget");
  assert.match(finished.error ?? "", /token budget exhausted/);
});

test("a non-resume run's maxAgents behaviour is unaffected by the resume fix", async () => {
  const manager = makeManager();

  const { promise } = manager.startInBackground(TWO_AGENT_SCRIPT, undefined, {
    maxAgents: 1,
  });
  await assert.rejects(promise, /Agent limit exceeded \(1\)/);

  const manager2 = makeManager();
  const { runId: runId2, promise: promise2 } = manager2.startInBackground(TWO_AGENT_SCRIPT, undefined, {
    maxAgents: 5,
  });
  await promise2;
  const snapshot = manager2.getSnapshot(runId2);
  assert.equal(snapshot?.agents.length, 2, "a fresh (non-resume) run with a sufficient cap still completes both agents");
});

/**
 * Poll the live in-memory run until `runId` reaches a terminal status
 * (completed/failed/aborted). resume() runs its execution detached (fire
 * and forget), so there is no promise to await directly the way
 * startInBackground()'s return value gives one; getRun() keeps the settled
 * ManagedRun (including its real WorkflowError) around for a handful of
 * terminal runs — see DEFAULT_MAX_TERMINAL_RUNS_IN_MEMORY — which easily
 * covers one run per test.
 */
async function waitForTerminal(
  manager: ReturnType<typeof makeManager>,
  runId: string,
): Promise<{ status: string; agents: Array<{ label: string }>; error?: string }> {
  for (let i = 0; i < 200; i++) {
    const managed = manager.getRun(runId);
    if (managed && (managed.status === "completed" || managed.status === "failed" || managed.status === "aborted")) {
      return {
        status: managed.status,
        agents: managed.snapshot.agents,
        error: managed.error?.message,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`run ${runId} did not reach a terminal status in time`);
}
