import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";

import { workflowProjectPaths } from "./extensions/dynamic-workflows/src/workflow-paths.ts";
import { readWorkflowRun } from "./workflow-run-reader.ts";

// These fixtures land under the temp PI_WORKFLOW_HOME that vitest.setup.ts
// installs, not the operator's real one — which is where an earlier version of
// this file left them, permanently.
//
// The runs dir is derived rather than spelled out: it used to be a literal
// path ending in the hash "semla-test-reader-fdc772a2fcc0", which is only
// correct for as long as nobody edits TEST_CWD.
const TEST_CWD = "/tmp/semla-test-reader";
const RUNS_DIR = workflowProjectPaths(TEST_CWD).runsDir;

type MinimalRunAgent = {
  id: number;
  label: string;
  prompt: string;
  startedAt: string;
  endedAt: string;
  status: string;
  stopReason?: string;
  compactions?: number;
  compactionReasons?: string[];
};

type MinimalRun = {
  agents: MinimalRunAgent[];
  phases: string[];
  runId: string;
  startedAt: string;
  completedAt: string;
  status: string;
  updatedAt: string;
  workflowName: string;
};

const MINIMAL_RUN: MinimalRun = {
  agents: [
    {
      id: 1,
      label: "agent-1",
      prompt: "list cute animals",
      startedAt: "2026-08-25T20:50:24.002Z",
      endedAt: "2026-08-25T20:50:25.925Z",
      status: "done",
    },
  ],
  phases: [],
  runId: "",
  startedAt: "2026-08-25T20:50:23.999Z",
  completedAt: "2026-08-25T20:50:34.237Z",
  status: "completed",
  updatedAt: "2026-08-25T20:50:34.237Z",
  workflowName: "cute_animals",
};

function writeRun(runId: string, ext: ".json" | ".tson", content: MinimalRun = MINIMAL_RUN) {
  mkdirSync(RUNS_DIR, { recursive: true });
  writeFileSync(join(RUNS_DIR, `${runId}${ext}`), JSON.stringify({ ...content, runId }));
}

afterAll(() => {
  rmSync(RUNS_DIR, { recursive: true, force: true });
});

test("reads a .json run file", () => {
  writeRun("run-json-only", ".json");
  const result = readWorkflowRun(TEST_CWD, "run-json-only");
  assert.ok(result, "should return a result for .json");
  assert.equal(result.runId, "run-json-only");
  assert.equal(result.agents[0].startedAt, "2026-08-25T20:50:24.002Z");
  assert.equal(result.agents[0].endedAt, "2026-08-25T20:50:25.925Z");
});

test("reads a .tson run file (legacy extension)", () => {
  writeRun("run-tson-only", ".tson");
  const result = readWorkflowRun(TEST_CWD, "run-tson-only");
  assert.ok(result, "should return a result for .tson");
  assert.equal(result.runId, "run-tson-only");
});

test("prefers .tson over .json when both exist", () => {
  writeRun("run-both", ".tson");
  // Write a different runId into the .json so we can tell which was read.
  mkdirSync(RUNS_DIR, { recursive: true });
  writeFileSync(
    join(RUNS_DIR, "run-both.json"),
    JSON.stringify({ ...MINIMAL_RUN, runId: "run-both-json-imposter" }),
  );
  const result = readWorkflowRun(TEST_CWD, "run-both");
  assert.equal(result?.runId, "run-both", ".tson should win");
});

test("returns null when no run file exists", () => {
  const result = readWorkflowRun(TEST_CWD, "run-does-not-exist");
  assert.equal(result, null);
});

test("falls back to .json.bak when .json is corrupt", () => {
  mkdirSync(RUNS_DIR, { recursive: true });
  writeFileSync(join(RUNS_DIR, "run-corrupt.json"), "{ not valid json");
  writeFileSync(
    join(RUNS_DIR, "run-corrupt.json.bak"),
    JSON.stringify({ ...MINIMAL_RUN, runId: "run-corrupt" }),
  );
  const result = readWorkflowRun(TEST_CWD, "run-corrupt");
  assert.ok(result, "should recover from .json.bak");
  assert.equal(result.runId, "run-corrupt");
});

test("agent startedAt and endedAt survive a round-trip", () => {
  writeRun("run-timestamps", ".json");
  const result = readWorkflowRun(TEST_CWD, "run-timestamps");
  assert.equal(result?.agents[0].startedAt, "2026-08-25T20:50:24.002Z");
  assert.equal(result?.agents[0].endedAt, "2026-08-25T20:50:25.925Z");
});

/**
 * A run is keyed by a hash of the cwd the extension ran under, and the reader
 * can only guess at that. Sessions stopped running at the workspace root (see
 * session-cwd.ts), so a caller's cwd and the run's key now routinely disagree —
 * and every run written before that change is keyed under the old cwd for the
 * rest of its life. A miss is silent: the panel shows nothing and the watchdog
 * never fires, while the workflow runs to completion.
 */
test("finds a run keyed under a different cwd than the caller's", () => {
  writeRun("run-elsewhere", ".json");

  // Read as a session anchored somewhere else entirely.
  const run = readWorkflowRun("/tmp/semla-test-reader/some/project", "run-elsewhere");

  assert.ok(run, "run written under another cwd's key should still be found");
  assert.equal(run.runId, "run-elsewhere");
});

test("still returns null for a run that is nowhere", () => {
  expect(readWorkflowRun(TEST_CWD, "run-that-never-existed")).toBeNull();
});

// docs/plans/subagent-context-pressure.md §4.4: "A run's JSON ... either
// carries stopReason / compactions per agent afterwards, or it does not."
test("an agent's stopReason/compactions/compactionReasons survive a round-trip", () => {
  writeRun("run-context-signals", ".json", {
    ...MINIMAL_RUN,
    agents: [
      {
        ...MINIMAL_RUN.agents[0],
        stopReason: "length",
        compactions: 2,
        compactionReasons: ["threshold", "overflow"],
      },
    ],
  });

  const result = readWorkflowRun(TEST_CWD, "run-context-signals");

  assert.ok(result, "should return a result");
  assert.equal(result.agents[0].stopReason, "length");
  assert.equal(result.agents[0].compactions, 2);
  assert.deepEqual(result.agents[0].compactionReasons, ["threshold", "overflow"]);
});

test("an agent with no context-pressure signals recorded round-trips without them", () => {
  writeRun("run-no-context-signals", ".json");

  const result = readWorkflowRun(TEST_CWD, "run-no-context-signals");

  assert.ok(result, "should return a result");
  assert.equal(result.agents[0].stopReason, undefined);
  assert.equal(result.agents[0].compactions, undefined);
  assert.equal(result.agents[0].compactionReasons, undefined);
});
