/**
 * The client now names the session, so this value arrives over the wire and
 * becomes a primary key, a directory name under .semla-sessions, and part of
 * every URL built from the session. It is validated to one shape rather than
 * trusted.
 */
import { describe, expect, it } from "vitest";

import { parseRequestedSessionId } from "./session-id.ts";

describe("parseRequestedSessionId", () => {
  it("accepts a uuid, which is what crypto.randomUUID() produces", () => {
    expect(parseRequestedSessionId("66a088f1-949b-494b-b39a-2b34fa4ebecc")).toBe(
      "66a088f1-949b-494b-b39a-2b34fa4ebecc",
    );
  });

  // Postgres renders uuids lower-case, so the same id must not compare unequal.
  it("normalises case", () => {
    expect(parseRequestedSessionId("66A088F1-949B-494B-B39A-2B34FA4EBECC")).toBe(
      "66a088f1-949b-494b-b39a-2b34fa4ebecc",
    );
  });

  it("tolerates surrounding whitespace", () => {
    expect(
      parseRequestedSessionId("  66a088f1-949b-494b-b39a-2b34fa4ebecc  "),
    ).toBe("66a088f1-949b-494b-b39a-2b34fa4ebecc");
  });

  /**
   * Null is not an error: it means Postgres names the session, which is what
   * every caller that does not mint an id relies on.
   */
  it.each([
    ["absent", undefined],
    ["null", null],
    ["a number", 1],
    ["an object", { id: "x" }],
    ["empty", ""],
    ["blank", "   "],
  ])("returns null for %s", (_label, value) => {
    expect(parseRequestedSessionId(value)).toBeNull();
  });

  /**
   * The shapes that matter: anything that could escape a path built from the
   * id, or a value that is merely uuid-ish.
   */
  it.each([
    "../../etc/passwd",
    "66a088f1-949b-494b-b39a-2b34fa4ebecc/../other",
    "66a088f1949b494bb39a2b34fa4ebecc",
    "66a088f1-949b-494b-b39a-2b34fa4ebec",
    "66a088f1-949b-494b-b39a-2b34fa4ebeccc",
    "66a088f1-949b-494b-b39a-2b34fa4ebecg",
    "'; drop table sessions; --",
  ])("rejects %s", (value) => {
    expect(parseRequestedSessionId(value)).toBeNull();
  });
});
