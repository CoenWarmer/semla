import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { WorkflowManager } from "./extensions/dynamic-workflows/src/workflow-manager.ts";

// A mock agent that resolves immediately — no real Pi session is started.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockAgent = { run: async () => "mock result" } as any;

let tmpDir: string;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "semla-wf-test-"));
});

after(() => {
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
