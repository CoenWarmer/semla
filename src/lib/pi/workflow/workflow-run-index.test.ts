/**
 * The snapshots were already on disk — the workflows route prefers the run file
 * because the database copy is only kept current for foreground runs. What
 * Postgres still owned was which runs a session has, so a panel came up empty
 * with every run file sitting right there.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  listRunningWorkflowRuns,
  listWorkflowRuns,
  upsertWorkflowRun,
} from "./workflow-run-index.ts";

const dir = () => mkdtempSync(join(tmpdir(), "semla-runs-"));

describe("workflow run index", () => {
  it("records a run and lists it back", () => {
    const d = dir();

    upsertWorkflowRun("s1", "run-a", { mode: "background", status: "running" }, d);

    const runs = listWorkflowRuns("s1", d);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.run_id).toBe("run-a");
    expect(runs[0]!.mode).toBe("background");
  });

  it("keeps runs of different sessions apart", () => {
    const d = dir();
    upsertWorkflowRun("s1", "run-a", {}, d);
    upsertWorkflowRun("s2", "run-b", {}, d);

    expect(listWorkflowRuns("s1", d).map((r) => r.run_id)).toEqual(["run-a"]);
    expect(listWorkflowRuns("s2", d).map((r) => r.run_id)).toEqual(["run-b"]);
  });

  // Snapshots arrive about ten a second; each one must update the run it
  // belongs to and leave the others alone.
  it("updates one run without disturbing its siblings", () => {
    const d = dir();
    upsertWorkflowRun("s1", "run-a", { status: "running" }, d);
    upsertWorkflowRun("s1", "run-b", { status: "running" }, d);

    upsertWorkflowRun("s1", "run-a", { status: "completed" }, d);

    const byId = new Map(listWorkflowRuns("s1", d).map((r) => [r.run_id, r.status]));
    expect(byId.get("run-a")).toBe("completed");
    expect(byId.get("run-b")).toBe("running");
  });

  it("keeps the original created_at across updates", () => {
    const d = dir();
    const first = upsertWorkflowRun("s1", "run-a", { status: "running" }, d);

    const later = upsertWorkflowRun("s1", "run-a", { status: "completed" }, d);

    expect(later.created_at).toBe(first.created_at);
  });

  it("orders newest first, as the panel renders them", () => {
    const d = dir();
    mkdirSync(join(d, "runs"), { recursive: true });
    writeFileSync(
      join(d, "runs", "s1.json"),
      JSON.stringify({
        old: { run_id: "old", mode: "foreground", status: "completed", error: null,
               created_at: "2026-08-30T10:00:00.000Z", updated_at: "2026-08-30T10:00:00.000Z" },
        recent: { run_id: "recent", mode: "foreground", status: "completed", error: null,
                  created_at: "2026-08-31T10:00:00.000Z", updated_at: "2026-08-31T10:00:00.000Z" },
      }),
      "utf8",
    );

    expect(listWorkflowRuns("s1", d).map((r) => r.run_id)).toEqual(["recent", "old"]);
  });

  it("finds the runs a new turn has to reconcile", () => {
    const d = dir();
    upsertWorkflowRun("s1", "done", { status: "completed" }, d);
    upsertWorkflowRun("s1", "live", { status: "running" }, d);

    expect(listRunningWorkflowRuns("s1", d).map((r) => r.run_id)).toEqual(["live"]);
  });

  it("has no runs for an unknown session, and does not throw", () => {
    expect(listWorkflowRuns("never-seen", dir())).toEqual([]);
  });

  it("survives a corrupt index rather than failing the panel", () => {
    const d = dir();
    mkdirSync(join(d, "runs"), { recursive: true });
    writeFileSync(join(d, "runs", "s1.json"), "{ truncated", "utf8");

    expect(listWorkflowRuns("s1", d)).toEqual([]);
    // And recovers on the next write.
    upsertWorkflowRun("s1", "run-a", {}, d);
    expect(listWorkflowRuns("s1", d).map((r) => r.run_id)).toEqual(["run-a"]);
  });

  it("writes valid JSON that round-trips", () => {
    const d = dir();
    upsertWorkflowRun("s1", "run-a", { status: "failed", error: "boom" }, d);

    const raw = JSON.parse(readFileSync(join(d, "runs", "s1.json"), "utf8")) as Record<
      string,
      { error: string | null }
    >;
    expect(raw["run-a"]!.error).toBe("boom");
  });
});
