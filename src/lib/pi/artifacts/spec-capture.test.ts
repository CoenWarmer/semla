import { rmSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { recordFeatureSpec, recordMarkerSpec } from "@/lib/pi/artifacts/spec-capture";
import { readSessionArtifactsFull } from "@/lib/pi/artifacts/artifact-store";
import { pendingArtifactCount } from "@/lib/pi/artifacts/artifact-persist-queue";

// spec-capture.ts calls appendArtifacts/queueArtifacts with their default
// disk root (SEMLA_ARTIFACT_DIR), so this test does not inject a `dir` the
// way artifact-store.test.ts does — it only asserts through the queue and a
// fresh session id, and cleans up the real artifact tree it wrote into.
import { SEMLA_ARTIFACT_DIR } from "@/lib/pi/runtime/runtime-config";

let sessionCounter = 0;
const sessionsUsed: string[] = [];
function freshSession(): string {
  sessionCounter += 1;
  const id = `spec-capture-test-${Date.now()}-${sessionCounter}`;
  sessionsUsed.push(id);
  return id;
}

// spec-capture.ts writes through the real SEMLA_ARTIFACT_DIR (it takes no
// `dir` parameter, unlike artifact-store.test.ts's direct calls), so each
// session directory this test creates is removed afterwards.
afterEach(() => {
  for (const id of sessionsUsed.splice(0)) {
    rmSync(join(SEMLA_ARTIFACT_DIR, "sessions", id), { force: true, recursive: true });
  }
});

describe("recordMarkerSpec", () => {
  it("writes one spec artifact keyed by turnId and the marker discriminator", () => {
    const sessionId = freshSession();
    recordMarkerSpec({
      roundId: "live-round-1",
      sessionId,
      text: "always use tabs",
      turnId: "turn-1",
      turnIndex: 3,
    });

    const artifacts = readSessionArtifactsFull(sessionId, SEMLA_ARTIFACT_DIR);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      key: "spec:turn-1:marker",
      kind: "spec",
      projectPath: null,
      source: "marker",
      text: "always use tabs",
      turnId: "turn-1",
      turnIndex: 3,
    });
    expect(pendingArtifactCount(sessionId)).toBeGreaterThanOrEqual(0);
  });

  it("accepts a null turnId rather than inventing one", () => {
    const sessionId = freshSession();
    recordMarkerSpec({
      roundId: null,
      sessionId,
      text: "no turn in flight",
      turnId: null,
      turnIndex: null,
    });

    const artifacts = readSessionArtifactsFull(sessionId, SEMLA_ARTIFACT_DIR);
    expect(artifacts[0].turnId).toBeNull();
    expect(artifacts[0].key).toBe("spec:null:marker");
  });

  it("re-running the same input is idempotent on read (dedupe by key)", () => {
    const sessionId = freshSession();
    for (let i = 0; i < 2; i += 1) {
      recordMarkerSpec({
        roundId: null,
        sessionId,
        text: "same turn, fired twice",
        turnId: "turn-1",
        turnIndex: 0,
      });
    }
    const artifacts = readSessionArtifactsFull(sessionId, SEMLA_ARTIFACT_DIR);
    expect(artifacts).toHaveLength(1);
  });
});

describe("recordFeatureSpec", () => {
  it("writes fields in submission order, keyed by turnId and toolCallId", () => {
    const sessionId = freshSession();
    recordFeatureSpec({
      fields: [
        { label: "Overarching goal", value: "ship the thing" },
        { label: "Functional requirements", value: "does the thing" },
      ],
      roundId: "live-round-2",
      sessionId,
      text: "ship the thing",
      toolCallId: "call-42",
      turnId: "turn-9",
    });

    const artifacts = readSessionArtifactsFull(sessionId, SEMLA_ARTIFACT_DIR);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      fields: [
        { label: "Overarching goal", value: "ship the thing" },
        { label: "Functional requirements", value: "does the thing" },
      ],
      key: "spec:turn-9:call-42",
      kind: "spec",
      projectPath: null,
      source: "form",
      toolCallId: "call-42",
      turnId: "turn-9",
    });
  });

  it("accepts a null turnId", () => {
    const sessionId = freshSession();
    recordFeatureSpec({
      fields: [{ label: "Overarching goal", value: "x" }],
      roundId: null,
      sessionId,
      text: "x",
      toolCallId: "call-1",
      turnId: null,
    });
    const artifacts = readSessionArtifactsFull(sessionId, SEMLA_ARTIFACT_DIR);
    expect(artifacts[0].turnId).toBeNull();
    expect(artifacts[0].key).toBe("spec:null:call-1");
  });
});
