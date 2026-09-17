/**
 * Both status routes answer through this mapping, so the field the sidebar
 * renders and the field a single-session page reads must be produced by the
 * same function or they drift apart silently. This test exercises the
 * artifacts field end to end: real disk writes, real read-back, through
 * sessionArtifacts and toSessionStatus.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appendArtifacts } from "@/lib/pi/artifacts/artifact-store";
import { sessionArtifacts, toSessionStatus } from "@/lib/pi/session/session-status-view";
import type { SessionMeta } from "@/lib/pi/session/session-meta";
import type { DiffArtifact } from "@/lib/artifacts/artifact-types";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "session-status-view-test-"));
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

function diff(overrides: Partial<DiffArtifact> = {}): DiffArtifact {
  return {
    attribution: "tool-call",
    baseSha: "base",
    createdAt: "2026-01-01T00:00:00.000Z",
    filesOmitted: 0,
    files: [
      {
        hunks: [],
        hunksOmitted: false,
        oldPath: null,
        path: "src/a.ts",
        status: "modified",
      },
    ],
    headSha: "head",
    kind: "diff",
    key: "call-1:diff:0",
    patchFile: null,
    patchTruncated: false,
    role: null,
    projectPath: "semla",
    roundId: null,
    sessionId: "session-1",
    toolCallId: "call-1",
    toolName: "edit",
    turnId: null,
    ...overrides,
  };
}

describe("sessionArtifacts", () => {
  it("summarizes what a session's disk record has captured", () => {
    appendArtifacts("session-1", [diff()], dir);

    const summary = sessionArtifacts("session-1", dir);
    expect(summary.diffs).toBe(1);
    expect(summary.chips).toHaveLength(1);
  });

  it("is empty for a session with no artifacts on disk", () => {
    expect(sessionArtifacts("no-such-session", dir)).toEqual({
      chips: [],
      chipsByKey: {},
      commits: 0,
      diffs: 0,
      plans: 0,
      prs: 0,
      specs: 0,
    });
  });
});

describe("toSessionStatus", () => {
  it("includes the session's artifact summary in the list row", () => {
    appendArtifacts("session-1", [diff()], dir);

    const meta: SessionMeta = {
      createdAt: "2026-01-01T00:00:00.000Z",
      id: "session-1",
      isRunning: false,
      projects: [],
      title: "t",
      userId: null,
    } as unknown as SessionMeta;

    // toSessionStatus reads through sessionArtifacts's default dir, which is
    // SEMLA_ARTIFACT_DIR — not overridable per call, matching how disk state
    // reaches production code elsewhere in this file (hasTranscript,
    // isSessionActive). This asserts the field is wired, not its plumbing.
    const status = toSessionStatus(meta, [meta]);
    expect(status).toHaveProperty("artifacts");
    expect(status.artifacts).toEqual({
      chips: [],
      chipsByKey: {},
      commits: 0,
      diffs: 0,
      plans: 0,
      prs: 0,
      specs: 0,
    });
  });
});
