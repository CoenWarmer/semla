import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendArtifacts,
  ARTIFACT_TAIL_BYTES,
  readSessionArtifacts,
  readSessionArtifactsFull,
  writePatch,
} from "@/lib/pi/artifacts/artifact-store";
import { ARTIFACT_PATCH_BYTES } from "@/lib/artifacts/artifact-types";
import type { CommitArtifact } from "@/lib/artifacts/artifact-types";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "artifact-store-test-"));
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

function commit(overrides: Partial<CommitArtifact> = {}): CommitArtifact {
  return {
    at: "2026-01-01T00:00:00.000Z",
    attribution: "tool-call",
    author: "agent",
    createdAt: "2026-01-01T00:00:00.000Z",
    fileCount: 1,
    files: ["a.ts"],
    kind: "commit",
    key: "call-1:commit:sha1",
    projectPath: "semla",
    roundId: null,
    sessionId: "session-1",
    sha: "sha1",
    shortSha: "sha1sh",
    subject: "fix foo",
    toolCallId: "call-1",
    toolName: "bash",
    turnId: null,
    ...overrides,
  };
}

describe("appendArtifacts / readSessionArtifacts", () => {
  it("round-trips an append then a read", () => {
    appendArtifacts("session-1", [commit()], dir);
    const result = readSessionArtifacts("session-1", dir);
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe("call-1:commit:sha1");
  });

  it("orders newest first", () => {
    appendArtifacts(
      "session-1",
      [
        commit({ createdAt: "2026-01-01T00:00:00.000Z", key: "k1", sha: "s1" }),
        commit({ createdAt: "2026-01-02T00:00:00.000Z", key: "k2", sha: "s2" }),
      ],
      dir,
    );
    const result = readSessionArtifacts("session-1", dir);
    expect(result.map((a) => a.key)).toEqual(["k2", "k1"]);
  });

  it("skips an unparsable line rather than failing", () => {
    appendArtifacts("session-1", [commit()], dir);
    const file = join(dir, "sessions", "session-1", "artifacts.jsonl");
    writeFileSync(file, "not json\n", { flag: "a" });
    const result = readSessionArtifacts("session-1", dir);
    expect(result).toHaveLength(1);
  });

  it("skips a truncated final line", () => {
    appendArtifacts("session-1", [commit()], dir);
    const file = join(dir, "sessions", "session-1", "artifacts.jsonl");
    writeFileSync(file, '{"key":"trunc","kind":"commit"', { flag: "a" });
    const result = readSessionArtifacts("session-1", dir);
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe("call-1:commit:sha1");
  });

  it("dedupes by key, keeping the newest occurrence", () => {
    appendArtifacts(
      "session-1",
      [commit({ createdAt: "2026-01-01T00:00:00.000Z", key: "k1", subject: "first" })],
      dir,
    );
    appendArtifacts(
      "session-1",
      [commit({ createdAt: "2026-01-02T00:00:00.000Z", key: "k1", subject: "second" })],
      dir,
    );
    const result = readSessionArtifacts("session-1", dir);
    expect(result).toHaveLength(1);
    expect((result[0] as CommitArtifact).subject).toBe("second");
  });

  it("reads only the tail of a long file", () => {
    const big: CommitArtifact[] = Array.from({ length: 2000 }, (_, i) =>
      commit({ createdAt: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`, key: `old-${i}`, sha: `old-${i}` }),
    );
    appendArtifacts("session-1", big, dir);
    appendArtifacts(
      "session-1",
      [commit({ createdAt: "2026-02-01T00:00:00.000Z", key: "newest", sha: "newest" })],
      dir,
    );

    const tailResult = readSessionArtifacts("session-1", dir);
    const fullResult = readSessionArtifactsFull("session-1", dir);

    expect(tailResult.some((a) => a.key === "newest")).toBe(true);
    expect(tailResult.length).toBeLessThan(fullResult.length);
  });

  it("returns [] without throwing for a session with no file", () => {
    expect(readSessionArtifacts("nonexistent-session", dir)).toEqual([]);
  });

  it("does not throw when writing to an unwritable dir", () => {
    expect(() => appendArtifacts("session-1", [commit()], "/nonexistent/deeply/nested/path")).not.toThrow();
  });
});

describe("writePatch", () => {
  it("writes a sidecar and returns a session-relative path", () => {
    const path = writePatch("session-1", "call-1:diff:0", "diff --git a/x b/x\n", dir);
    expect(path).toBe("patches/call-1_diff_0.patch");
  });

  it("truncates at ARTIFACT_PATCH_BYTES", () => {
    const huge = "x".repeat(ARTIFACT_PATCH_BYTES + 1000);
    const path = writePatch("session-1", "call-1:diff:0", huge, dir);
    expect(path).not.toBeNull();
    const written = readFileSync(join(dir, "sessions", "session-1", path!), "utf8");
    expect(Buffer.byteLength(written, "utf8")).toBeLessThanOrEqual(ARTIFACT_PATCH_BYTES);
  });

  it("does not throw for an unwritable dir, and returns null", () => {
    expect(writePatch("session-1", "k", "patch", "/nonexistent/deeply/nested/path")).toBeNull();
  });
});

// Guard the tail-cap constant itself, so a change to it is deliberate.
describe("ARTIFACT_TAIL_BYTES", () => {
  it("is set to 64KB", () => {
    expect(ARTIFACT_TAIL_BYTES).toBe(64 * 1024);
  });
});
