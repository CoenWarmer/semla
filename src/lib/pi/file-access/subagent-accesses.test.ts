import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { listWorkflowRuns } from "@/lib/pi/workflow/workflow-run-index";
import { snapshotFromRunFile } from "@/lib/pi/workflow/workflow-service";

import { turnForRun, withSubagentAccesses } from "./subagent-accesses.ts";
import type { FileAccessTimeline, TimelineTurn } from "./access-types.ts";

// `listWorkflowRuns`/`snapshotFromRunFile` read from paths this test cannot
// point at a temp dir — the run index lives under `SEMLA_STATE_DIR`, and a
// run file is found via `PI_WORKSPACE_ROOT`/`process.cwd()`. Everything else
// `withSubagentAccesses` touches — the session meta, the subagent's own
// transcript, `indexAgentTranscripts`' directory scan — is real files under a
// temp dir, exactly as `access-timeline.test.ts` exercises the host session.
vi.mock("@/lib/pi/workflow/workflow-run-index", () => ({ listWorkflowRuns: vi.fn() }));
vi.mock("@/lib/pi/workflow/workflow-service", () => ({ snapshotFromRunFile: vi.fn() }));

const turns: TimelineTurn[] = [
  { at: "2026-01-01T10:00:00.000Z", id: "u1" },
  { at: "2026-01-01T11:00:00.000Z", id: "u2" },
  { at: "2026-01-01T12:00:00.000Z", id: "u3" },
];

describe("turnForRun", () => {
  it("attributes a run to the turn that was in progress when it started", () => {
    expect(turnForRun(turns, "2026-01-01T11:30:00.000Z")).toBe("u2");
  });

  it("attributes a run started exactly on a turn boundary to that turn", () => {
    expect(turnForRun(turns, "2026-01-01T11:00:00.000Z")).toBe("u2");
  });

  it("attributes a run predating every prompt to the synthetic root", () => {
    expect(turnForRun(turns, "2025-12-31T00:00:00.000Z")).toBe("\u2039root\u203a");
  });

  it("attributes a run with no recorded start to the most recent turn", () => {
    // Ordinary for a run file written before `created_at` was recorded. The
    // latest turn is the better guess than the first, and better than dropping
    // the subagent's reads entirely.
    expect(turnForRun(turns, null)).toBe("u3");
  });

  it("falls back to the root when there are no turns at all", () => {
    expect(turnForRun([], "2026-01-01T11:00:00.000Z")).toBe("\u2039root\u203a");
  });

  it("skips an undated turn rather than stopping at it", () => {
    // An entry that never carried a timestamp. Treating it as the end of the
    // scan would orphan every subagent that ran after it.
    expect(
      turnForRun([{ at: "", id: "u0" }, ...turns], "2026-01-01T11:30:00.000Z"),
    ).toBe("u2");
  });
});

describe("withSubagentAccesses", () => {
  const SESSION = "22222222-3333-4444-5555-666666666666";
  let dir: string;

  const baseTimeline: FileAccessTimeline = {
    agents: [],
    calls: [],
    turns: [{ at: "2026-01-01T00:00:00.000Z", id: "u1" }],
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "semla-subagent-"));
    writeFileSync(
      join(dir, `${SESSION}.json`),
      JSON.stringify({
        id: SESSION,
        projects: [
          {
            firstAttachedAt: "",
            isPrimary: true,
            lastTouchedAt: "",
            origin: "explicit",
            path: "semla",
          },
        ],
      }),
      "utf8",
    );
    vi.mocked(listWorkflowRuns).mockReset();
    vi.mocked(snapshotFromRunFile).mockReset();
  });

  const run = "run1";
  const runRecord = {
    created_at: "2026-01-01T00:00:01.000Z",
    error: null,
    mode: "foreground" as const,
    run_id: run,
    status: "completed" as const,
    updated_at: "2026-01-01T00:00:02.000Z",
  };
  const snapshot = {
    agentCount: 1,
    agents: [{ id: 1, label: "reviewer", status: "done" as const }],
    doneCount: 1,
    errorCount: 0,
    name: "review",
    phases: [],
    runningCount: 0,
  };

  it("keeps an agent whose only calls touched no file", () => {
    // A subagent that only ran `ask_user` or an unrecognised `bash` made no
    // access at all under the old model, and was dropped entirely. It now
    // appears once "All tools" asks to see it.
    vi.mocked(listWorkflowRuns).mockReturnValue([runRecord]);
    vi.mocked(snapshotFromRunFile).mockReturnValue(snapshot);
    writeFileSync(
      join(dir, "workflow-run1-reviewer.jsonl"),
      [
        JSON.stringify({ name: "workflow:run1 reviewer", type: "session_info" }),
        JSON.stringify({
          id: "su1",
          message: { content: "go review it", role: "user" },
          parentId: null,
          timestamp: "2026-01-01T00:00:01.500Z",
          type: "message",
        }),
        JSON.stringify({
          id: "sa1",
          message: {
            content: [
              { arguments: { command: "npm test" }, id: "sc1", name: "bash", type: "toolCall" },
            ],
            role: "assistant",
          },
          parentId: "su1",
          timestamp: "2026-01-01T00:00:02.000Z",
          type: "message",
        }),
      ].join("\n"),
      "utf8",
    );

    const merged = withSubagentAccesses(SESSION, baseTimeline, {
      dir,
      exists: () => true,
      workspaceRoot: "/ws",
    });

    expect(merged.agents).toEqual([{ id: "run1:1", label: "reviewer" }]);
    expect(merged.calls).toHaveLength(1);
    expect(merged.calls[0]).toMatchObject({ accesses: [], name: "bash" });
  });

  it("drops an agent with no persisted transcript at all", () => {
    // Distinct from the case above: no transcript means nothing was found to
    // read, not that what was read touched no file.
    vi.mocked(listWorkflowRuns).mockReturnValue([runRecord]);
    vi.mocked(snapshotFromRunFile).mockReturnValue(snapshot);

    const merged = withSubagentAccesses(SESSION, baseTimeline, {
      dir,
      exists: () => true,
      workspaceRoot: "/ws",
    });

    expect(merged).toBe(baseTimeline);
  });

  it("returns the timeline unchanged when the session ran no workflows", () => {
    vi.mocked(listWorkflowRuns).mockReturnValue([]);

    const merged = withSubagentAccesses(SESSION, baseTimeline, {
      dir,
      exists: () => true,
      workspaceRoot: "/ws",
    });

    expect(merged).toBe(baseTimeline);
    expect(snapshotFromRunFile).not.toHaveBeenCalled();
  });
});
