import { describe, expect, it } from "vitest";

import { isTurnId, mintTurnId } from "@/lib/pi/session/turn-id";

describe("mintTurnId", () => {
  it("matches the documented shape", () => {
    const id = mintTurnId(new Date("2026-09-10T12:12:12.345Z"));
    expect(id).toMatch(/^\d{8}T\d{9}Z-[0-9a-f]{8}$/);
    expect(id.startsWith("20260910T121212345Z-")).toBe(true);
  });

  it("sorts the same way its clock readings do", () => {
    const earlier = mintTurnId(new Date("2026-01-01T00:00:00.000Z"));
    const later = mintTurnId(new Date("2026-01-02T00:00:00.000Z"));
    expect(earlier < later).toBe(true);
  });

  it("mints 10k distinct ids", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10_000; i += 1) ids.add(mintTurnId());
    expect(ids.size).toBe(10_000);
  });
});

describe("isTurnId", () => {
  it("accepts a minted id", () => {
    expect(isTurnId(mintTurnId())).toBe(true);
  });

  it("rejects a bare ISO timestamp", () => {
    expect(isTurnId(new Date().toISOString())).toBe(false);
  });

  it("rejects a live-round id", () => {
    expect(isTurnId("live-round-3")).toBe(false);
  });

  it("rejects garbage", () => {
    expect(isTurnId("")).toBe(false);
    expect(isTurnId("not-a-turn-id")).toBe(false);
  });
});
