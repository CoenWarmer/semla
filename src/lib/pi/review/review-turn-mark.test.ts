import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readTurnMark, writeTurnMark } from "@/lib/pi/review/review-turn-mark";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "review-turn-mark-test-"));
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

describe("ReviewTurnMark.turnId", () => {
  it("round-trips through write/read", () => {
    writeTurnMark(
      "session-1",
      { projects: {}, reviewed: null, startedAt: "2026-01-01T00:00:00.000Z", turnId: "turn-1" },
      dir,
    );
    expect(readTurnMark("session-1", dir)?.turnId).toBe("turn-1");
  });

  it("reads a mark written before turnId existed as null", () => {
    // Same on-disk layout review-turn-mark.ts writes: <dir>/review/<id>.json.
    mkdirSync(join(dir, "review"), { recursive: true });
    writeFileSync(
      join(dir, "review", "session-1.json"),
      JSON.stringify({
        projects: {},
        reviewed: null,
        startedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    expect(readTurnMark("session-1", dir)?.turnId).toBeNull();
  });
});
