import { describe, expect, it } from "vitest";

import {
  clearSession,
  getSnapshot,
  putSnapshot,
  seedSnapshots,
} from "@/lib/pi/artifacts/artifact-snapshot-cache";
import type { ProjectSnapshot } from "@/lib/pi/artifacts/artifact-snapshot";

function snapshot(overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    at: "2026-01-01T00:00:00.000Z",
    files: [],
    head: "h1",
    projectPath: "semla",
    root: "/workspace/semla",
    state: "state-1",
    ...overrides,
  };
}

describe("artifact-snapshot-cache", () => {
  it("seed then get returns what was seeded", () => {
    seedSnapshots("s1", [snapshot()]);
    expect(getSnapshot("s1", "semla")).toEqual(snapshot());
  });

  it("put overwrites the cached snapshot for that project", () => {
    seedSnapshots("s2", [snapshot()]);
    putSnapshot("s2", snapshot({ head: "h2", state: "state-2" }));
    expect(getSnapshot("s2", "semla")?.head).toBe("h2");
  });

  it("two sessions do not see each other's snapshots", () => {
    seedSnapshots("s3", [snapshot({ head: "s3-head" })]);
    seedSnapshots("s4", [snapshot({ head: "s4-head" })]);
    expect(getSnapshot("s3", "semla")?.head).toBe("s3-head");
    expect(getSnapshot("s4", "semla")?.head).toBe("s4-head");
  });

  it("clearSession leaves other sessions intact", () => {
    seedSnapshots("s5", [snapshot()]);
    seedSnapshots("s6", [snapshot()]);
    clearSession("s5");
    expect(getSnapshot("s5", "semla")).toBeUndefined();
    expect(getSnapshot("s6", "semla")).toEqual(snapshot());
  });

  it("returns undefined for a project never seeded", () => {
    expect(getSnapshot("s7", "unknown")).toBeUndefined();
  });
});
