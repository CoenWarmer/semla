/**
 * The header and the sidebar disagreed by 3,691 tokens on a real session —
 * one agent's worth. The run file said 9,052, and its three agents (2,675,
 * 2,686, 3,691) sum to exactly that; the `workflow_runs` snapshot column said
 * 5,361, having been persisted partway through and never updated. The header
 * read disk and was right.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { workflowUsageFromDisk } from "@/lib/pi/workflow-usage-disk";

const SESSION = "ff87897d-c13b-4088-ae83-ad88a7f71ccf";

let dir: string;

const index = async (runs: Record<string, unknown>) => {
  await mkdir(join(dir, "runs"), { recursive: true });
  await writeFile(join(dir, "runs", `${SESSION}.json`), JSON.stringify(runs));
};

const record = (runId: string) => ({
  created_at: "2026-09-03T00:00:00.000Z",
  error: null,
  mode: "background" as const,
  run_id: runId,
  status: "completed" as const,
  updated_at: "2026-09-03T00:00:01.000Z",
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "semla-wfusage-"));
});

describe("workflowUsageFromDisk", () => {
  it("sums the run files the index points at", async () => {
    await index({ a: record("run-a"), b: record("run-b") });

    const result = workflowUsageFromDisk(SESSION, {
      dir,
      readRun: (runId) => ({
        tokenUsage: { cost: runId === "run-a" ? 0.006 : 0.001, total: runId === "run-a" ? 9_052 : 100 },
      }),
    });

    expect(result.indexed).toBe(true);
    expect(result.usage).toEqual({ cost: 0.007, tokens: 9_152 });
    expect(result.withoutFile).toEqual([]);
  });

  it("reports a session with no index rather than claiming zero", async () => {
    const result = workflowUsageFromDisk(SESSION, { dir, readRun: () => null });

    // A session predating the index is the one case disk cannot answer, and
    // the caller has to know to ask the backup instead.
    expect(result.indexed).toBe(false);
    expect(result.usage).toEqual({ cost: 0, tokens: 0 });
  });

  it("names runs whose file is missing instead of counting them as zero", async () => {
    await index({ a: record("run-a"), b: record("gone") });

    const result = workflowUsageFromDisk(SESSION, {
      dir,
      readRun: (runId) =>
        runId === "gone" ? null : { tokenUsage: { cost: 0.006, total: 9_052 } },
    });

    // Written by another machine, or pruned. Silently zero would understate.
    expect(result.withoutFile).toEqual(["gone"]);
    expect(result.usage.tokens).toBe(9_052);
  });

  it("treats a run file with no usage as nothing", async () => {
    await index({ a: record("run-a") });

    const result = workflowUsageFromDisk(SESSION, {
      dir,
      readRun: () => ({ tokenUsage: null }),
    });

    expect(result.indexed).toBe(true);
    expect(result.usage).toEqual({ cost: 0, tokens: 0 });
    expect(result.withoutFile).toEqual([]);
  });
});
