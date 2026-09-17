import { describe, expect, it } from "vitest";

import { attributeArtifactsToSpecs } from "@/lib/artifacts/spec-attribution";
import type { DiffArtifact, SpecArtifact } from "@/lib/artifacts/artifact-types";

function spec(overrides: Partial<SpecArtifact> = {}): SpecArtifact {
  return {
    attribution: "turn",
    createdAt: "2026-01-01T00:00:00.000Z",
    fields: [],
    key: "spec:t1:marker",
    kind: "spec",
    projectPath: null,
    roundId: null,
    sessionId: "s1",
    source: "marker",
    text: "always use tabs",
    toolCallId: null,
    toolName: null,
    turnId: "t1",
    turnIndex: 0,
    ...overrides,
  };
}

function diff(overrides: Partial<DiffArtifact> = {}): DiffArtifact {
  return {
    attribution: "tool-call",
    baseSha: null,
    createdAt: "2026-01-01T00:05:00.000Z",
    files: [],
    filesOmitted: 0,
    headSha: null,
    key: "call-1:diff:0",
    kind: "diff",
    patchFile: null,
    patchTruncated: false,
    role: null,
    projectPath: "repo",
    roundId: null,
    sessionId: "s1",
    toolCallId: "call-1",
    toolName: "edit",
    turnId: "t1",
    ...overrides,
  };
}

describe("attributeArtifactsToSpecs", () => {
  it("links an artifact with a matching turnId as same-turn", () => {
    const s = spec({ turnId: "t1" });
    const d = diff({ turnId: "t1" });
    const { specs } = attributeArtifactsToSpecs([s, d]);
    expect(specs).toHaveLength(1);
    expect(specs[0].produced).toEqual([{ artifact: d, strength: "same-turn" }]);
  });

  it("links a later artifact before the next spec as 'after'", () => {
    const s = spec({ createdAt: "2026-01-01T00:00:00.000Z", turnId: "t1" });
    const d = diff({ createdAt: "2026-01-01T00:10:00.000Z", turnId: "t2" });
    const { specs, unattributed } = attributeArtifactsToSpecs([s, d]);
    expect(specs[0].produced).toEqual([{ artifact: d, strength: "after" }]);
    expect(unattributed).toEqual([]);
  });

  it("attributes an artifact to the nearest preceding spec, not an earlier one", () => {
    const s1 = spec({ createdAt: "2026-01-01T00:00:00.000Z", key: "spec:t1:marker", turnId: "t1" });
    const s2 = spec({ createdAt: "2026-01-01T00:05:00.000Z", key: "spec:t2:marker", turnId: "t2" });
    const d = diff({ createdAt: "2026-01-01T00:10:00.000Z", turnId: "t3" });
    const { specs } = attributeArtifactsToSpecs([s1, s2, d]);
    const bySpec = new Map(specs.map((s) => [s.spec.key, s.produced]));
    expect(bySpec.get("spec:t1:marker")).toEqual([]);
    expect(bySpec.get("spec:t2:marker")).toEqual([{ artifact: d, strength: "after" }]);
  });

  it("never marks a null-turnId artifact as same-turn", () => {
    const s = spec({ createdAt: "2026-01-01T00:00:00.000Z", turnId: null });
    const d = diff({ createdAt: "2026-01-01T00:10:00.000Z", turnId: null });
    const { specs } = attributeArtifactsToSpecs([s, d]);
    expect(specs[0].produced).toEqual([{ artifact: d, strength: "after" }]);
  });

  it("returns artifacts before the first spec as unattributed", () => {
    const d = diff({ createdAt: "2025-12-31T00:00:00.000Z", turnId: "t0" });
    const s = spec({ createdAt: "2026-01-01T00:00:00.000Z", turnId: "t1" });
    const { specs, unattributed } = attributeArtifactsToSpecs([d, s]);
    expect(specs[0].produced).toEqual([]);
    expect(unattributed).toEqual([d]);
  });

  it("orders two specs in one turn by createdAt and links same-turn to both when turnId matches", () => {
    const s1 = spec({
      createdAt: "2026-01-01T00:00:01.000Z",
      key: "spec:t1:marker",
      turnId: "t1",
    });
    const s2 = spec({
      createdAt: "2026-01-01T00:00:00.000Z",
      key: "spec:t1:call-1",
      source: "form",
      toolCallId: "call-1",
      turnId: "t1",
    });
    const d = diff({ createdAt: "2026-01-01T00:00:02.000Z", turnId: "t1" });
    const { specs } = attributeArtifactsToSpecs([s1, s2, d]);
    // Oldest spec first.
    expect(specs.map((s) => s.spec.key)).toEqual(["spec:t1:call-1", "spec:t1:marker"]);
    // Both specs share turnId "t1" with the diff, so both claim it same-turn.
    for (const attribution of specs) {
      expect(attribution.produced).toEqual([{ artifact: d, strength: "same-turn" }]);
    }
  });

  it("is deterministic across repeated calls with the same input", () => {
    const s = spec();
    const d1 = diff({ createdAt: "2026-01-01T00:05:00.000Z", key: "a:diff:0" });
    const d2 = diff({ createdAt: "2026-01-01T00:05:00.000Z", key: "b:diff:0" });
    const first = attributeArtifactsToSpecs([s, d2, d1]);
    const second = attributeArtifactsToSpecs([s, d1, d2]);
    expect(first).toEqual(second);
  });
});
