import { describe, expect, it } from "vitest";

import type { ArtifactChip } from "@/lib/artifacts/artifact-summary";

import { artifactTargetFor } from "./session-artifact-click.ts";

const chip = (over: Partial<ArtifactChip> = {}): ArtifactChip => ({
  attribution: "tool-call",
  createdAt: "2026-01-01T00:00:00.000Z",
  key: "call-1:diff:0",
  kind: "diff",
  label: "1 file",
  projectPath: "semla",
  target: {
    anchor: null,
    commitSha: null,
    path: "src/a.ts",
    project: "semla",
  },
  ...over,
});

describe("artifactTargetFor", () => {
  it("is null for a spec chip — there is no code location to open", () => {
    expect(
      artifactTargetFor(
        chip({ kind: "spec", projectPath: null, target: null, spec: { fields: [], source: "marker", text: "x", turnIndex: 0 } }),
      ),
    ).toBeNull();
  });

  it("is null for a pr chip, which has no target", () => {
    expect(
      artifactTargetFor(chip({ kind: "pr", target: null, url: "https://x" })),
    ).toBeNull();
  });

  it("is null for a chip with no target", () => {
    expect(artifactTargetFor(chip({ target: null }))).toBeNull();
  });

  it("leaves line undefined when the target has no anchor", () => {
    const result = artifactTargetFor(chip());
    expect(result?.line).toBeUndefined();
    expect(result?.path).toBe("src/a.ts");
    expect(result?.project).toBe("semla");
    expect(result?.precision).toBe("exact");
  });

  it("sets line to the anchor's newStart when present", () => {
    const result = artifactTargetFor(
      chip({
        target: {
          anchor: {
            heading: null,
            index: 0,
            newLines: 2,
            newStart: 42,
            oldLines: 2,
            oldStart: 40,
          },
          commitSha: null,
          path: "src/a.ts",
          project: "semla",
        },
      }),
    );
    expect(result?.line).toBe(42);
    expect(result?.anchor?.newStart).toBe(42);
  });

  it("carries commitSha through for a commit chip", () => {
    const result = artifactTargetFor(
      chip({
        kind: "commit",
        target: {
          anchor: null,
          commitSha: "abc123",
          path: "src/a.ts",
          project: "semla",
        },
      }),
    );
    expect(result?.commitSha).toBe("abc123");
    expect(result?.anchor).toBeNull();
  });
});
