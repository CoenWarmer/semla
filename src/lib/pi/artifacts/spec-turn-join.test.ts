/**
 * End-to-end on disk, no git and no database: a spec artifact and a diff
 * artifact sharing one turnId, written into one artifacts.jsonl exactly the
 * way spec-capture.ts and artifact-capture.ts do, then read back and joined
 * by attributeArtifactsToSpecs — the answer to "which requirement led to
 * which code outcome" this whole work item exists to make possible.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appendArtifacts, readSessionArtifactsFull } from "@/lib/pi/artifacts/artifact-store";
import { attributeArtifactsToSpecs } from "@/lib/artifacts/spec-attribution";
import type { DiffArtifact, SpecArtifact } from "@/lib/artifacts/artifact-types";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "spec-turn-join-test-"));
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

describe("spec artifact <-> code artifact join", () => {
  it("links a same-turn diff to the spec that shares its turnId", () => {
    const sessionId = "session-join-1";

    const spec: SpecArtifact = {
      attribution: "turn",
      createdAt: "2026-01-01T00:00:00.000Z",
      fields: [],
      key: "spec:turn-7:marker",
      kind: "spec",
      projectPath: null,
      roundId: "live-round-1",
      sessionId,
      source: "marker",
      text: "use tabs, not spaces",
      toolCallId: null,
      toolName: null,
      turnId: "turn-7",
      turnIndex: 1,
    };

    const diff: DiffArtifact = {
      attribution: "tool-call",
      baseSha: "base",
      createdAt: "2026-01-01T00:00:05.000Z",
      files: [
        {
          hunks: [],
          hunksOmitted: false,
          oldPath: null,
          path: "src/foo.ts",
          status: "modified",
        },
      ],
      filesOmitted: 0,
      headSha: "head",
      key: "call-9:diff:0",
      kind: "diff",
      patchFile: null,
      patchTruncated: false,
      role: null,
      projectPath: "semla",
      roundId: "live-round-1",
      sessionId,
      toolCallId: "call-9",
      toolName: "edit",
      turnId: "turn-7",
    };

    appendArtifacts(sessionId, [spec, diff], dir);

    const read = readSessionArtifactsFull(sessionId, dir);
    expect(read).toHaveLength(2);

    const { specs, unattributed } = attributeArtifactsToSpecs(read);
    expect(specs).toHaveLength(1);
    expect(specs[0].spec.key).toBe("spec:turn-7:marker");
    expect(specs[0].produced).toHaveLength(1);
    expect(specs[0].produced[0].strength).toBe("same-turn");
    expect(specs[0].produced[0].artifact.key).toBe("call-9:diff:0");
    expect(unattributed).toEqual([]);
  });
});
