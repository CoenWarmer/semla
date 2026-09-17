import { describe, expect, it } from "vitest";

import {
  artifactKey,
  sanitizedArtifactKey,
  specArtifactKey,
} from "@/lib/pi/artifacts/artifact-key";

describe("artifactKey", () => {
  it("builds a tool-call key from toolCallId, kind and discriminator", () => {
    expect(
      artifactKey({
        attribution: "tool-call",
        discriminator: "0",
        kind: "diff",
        projectPath: "semla",
        toolCallId: "call-1",
      }),
    ).toBe("call-1:diff:0");
  });

  it("builds a turn key from turnStartedAt, projectPath, kind and discriminator", () => {
    expect(
      artifactKey({
        attribution: "turn",
        discriminator: "sha1",
        kind: "commit",
        projectPath: "semla",
        turnStartedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toBe("turn:2026-01-01T00:00:00.000Z:semla:commit:sha1");
  });

  it("is deterministic: the same input always yields the same key", () => {
    const input = {
      attribution: "tool-call" as const,
      discriminator: "0",
      kind: "diff" as const,
      projectPath: "semla",
      toolCallId: "call-1",
    };
    expect(artifactKey(input)).toBe(artifactKey(input));
  });

  it("gives different commits in one call different keys", () => {
    const first = artifactKey({
      attribution: "tool-call",
      discriminator: "sha1",
      kind: "commit",
      projectPath: "semla",
      toolCallId: "call-1",
    });
    const second = artifactKey({
      attribution: "tool-call",
      discriminator: "sha2",
      kind: "commit",
      projectPath: "semla",
      toolCallId: "call-1",
    });
    expect(first).not.toBe(second);
  });
});

describe("specArtifactKey", () => {
  it("builds a marker key from the turn id", () => {
    expect(specArtifactKey("turn-1", "marker")).toBe("spec:turn-1:marker");
  });

  it("builds a form key from the turn id and tool call id", () => {
    expect(specArtifactKey("turn-1", "call-9")).toBe("spec:turn-1:call-9");
  });

  it("accepts a null turn id rather than inventing one", () => {
    expect(specArtifactKey(null, "marker")).toBe("spec:null:marker");
  });
});

describe("sanitizedArtifactKey", () => {
  it("strips separators", () => {
    expect(sanitizedArtifactKey("call-1:diff:0")).toBe("call-1_diff_0");
  });

  it("caps length and stays unique for two long keys sharing a prefix", () => {
    const prefix = "call-1:pr:https://github.com/owner/repo/pull/".padEnd(150, "x");
    const first = sanitizedArtifactKey(`${prefix}1`);
    const second = sanitizedArtifactKey(`${prefix}2`);
    expect(first.length).toBeLessThanOrEqual(120);
    expect(second.length).toBeLessThanOrEqual(120);
    expect(first).not.toBe(second);
  });
});
