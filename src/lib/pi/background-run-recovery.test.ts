/**
 * Chatting during a background workflow used to orphan it: the new prompt
 * aborts the continuation watching the run, and a turn that started no workflow
 * of its own armed no replacement. The run kept going with nothing persisting
 * its snapshots, nothing holding the running flag, and nothing waiting to
 * deliver the result.
 */
import { describe, expect, it, vi } from "vitest";

import { unfinishedBackgroundRunId } from "@/lib/pi/background-run-recovery";
import type { WorkflowRunRecord } from "@/lib/pi/workflow-run-index";
import type { PersistedRunState } from "@/lib/pi/workflow-run-reader";

const record = (over: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord => ({
  run_id: "run-1",
  mode: "background" as const,
  status: "running" as const,
  error: null,
  created_at: "2026-09-02T09:00:00.000Z",
  updated_at: "2026-09-02T09:00:00.000Z",
  ...over,
});

const runFile = (status: string) =>
  ({ status, agents: [], workflowName: "audit" }) as unknown as PersistedRunState;

const find = (
  runs: WorkflowRunRecord[],
  files: Record<string, PersistedRunState | null>,
) =>
  unfinishedBackgroundRunId("s1", "/ws", {
    listRuns: () => runs,
    readRun: (_cwd, id) => files[id] ?? null,
  });

describe("unfinishedBackgroundRunId", () => {
  it("finds a background run the file agrees is still going", () => {
    expect(find([record()], { "run-1": runFile("running") })).toBe("run-1");
  });

  /**
   * The index is written from snapshot events, so a run whose watcher died
   * stays marked running in it forever — this repository accumulated entries a
   * week and a half old. Arming a continuation for each would mean waiting out
   * a thirty-minute timeout for a result that arrived days ago.
   */
  it.each(["completed", "failed", "aborted"])(
    "ignores a run the index calls running but the file reports %s",
    (status) => {
      expect(find([record()], { "run-1": runFile(status) })).toBeUndefined();
    },
  );

  it("ignores a run with no file, which has nothing to watch or deliver", () => {
    expect(find([record()], {})).toBeUndefined();
  });

  it("ignores foreground runs, which no continuation waits on", () => {
    expect(
      find([record({ mode: "foreground" })], { "run-1": runFile("running") }),
    ).toBeUndefined();
  });

  it("has nothing to report for a session with no runs", () => {
    expect(find([], {})).toBeUndefined();
  });

  it("skips finished runs to reach the one still going", () => {
    const runs = [record({ run_id: "old" }), record({ run_id: "live" })];
    const files = { old: runFile("completed"), live: runFile("running") };

    expect(find(runs, files)).toBe("live");
  });

  it("reads the run file rather than trusting the index", () => {
    // Guards the whole point of this module: an index-only check would return
    // the run, and the caller would watch something already over.
    const readRun = vi.fn(() => runFile("completed"));

    const result = unfinishedBackgroundRunId("s1", "/ws", {
      listRuns: () => [record()],
      readRun,
    });

    expect(readRun).toHaveBeenCalledWith("/ws", "run-1");
    expect(result).toBeUndefined();
  });
});
