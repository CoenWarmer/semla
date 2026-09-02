import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { isSessionMissing, promptFailureMessage } from "./prompt-failure.ts";

const FALLBACK = "Pi could not start this prompt.";

describe("promptFailureMessage", () => {
  it("surfaces the route's message", async () => {
    // The case that started this: a session whose creation handoff was lost.
    const message = await promptFailureMessage({
      json: async () => ({ error: "Session not found." }),
      ok: false,
    });

    expect(message).toBe("Session not found.");
  });

  it("does not read the body of a successful response", async () => {
    let read = false;

    const message = await promptFailureMessage({
      json: async () => {
        read = true;
        return {};
      },
      ok: true,
    });

    // That body is the event stream. Consuming it would end the turn it was
    // about to carry.
    expect(read).toBe(false);
    expect(message).toBe(FALLBACK);
  });

  it("falls back when the body is not JSON", async () => {
    const message = await promptFailureMessage({
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
      ok: false,
    });

    // A proxy or a crash page, not something to put in front of anyone.
    expect(message).toBe(FALLBACK);
  });

  it("falls back on a body with nothing to say", async () => {
    for (const body of [{}, { error: "" }, { error: "   " }, { error: 7 }, null]) {
      expect(
        await promptFailureMessage({ json: async () => body, ok: false }),
      ).toBe(FALLBACK);
    }
  });
});

describe("isSessionMissing", () => {
  const state = (over: Partial<Parameters<typeof isSessionMissing>[0]>) => ({
    exists: false,
    promptErrored: false,
    promptIdle: true,
    ...over,
  });

  it("is true for a page that never tried to create its session", () => {
    expect(isSessionMissing(state({}))).toBe(true);
  });

  it("stays true after a prompt has been typed and refused", () => {
    expect(
      isSessionMissing(state({ promptErrored: true, promptIdle: false })),
    ).toBe(true);
  });

  it("says nothing before the first status poll answers", () => {
    // Undefined is not a claim. A ?new=1 page is legitimately promptable
    // before its session exists — that is the point of creating on first
    // prompt.
    expect(isSessionMissing(state({ exists: undefined }))).toBe(false);
  });

  it("is false while the creating prompt is in flight", () => {
    // The handoff fired, so the mutation is pending: not idle, not errored.
    expect(
      isSessionMissing(state({ promptErrored: false, promptIdle: false })),
    ).toBe(false);
  });

  it("is false once the session exists", () => {
    expect(isSessionMissing(state({ exists: true }))).toBe(false);
    expect(
      isSessionMissing(state({ exists: true, promptErrored: true, promptIdle: false })),
    ).toBe(false);
  });
});

/**
 * The client can only tell mid-creation from never-created if the route says
 * so, and it is one word in each of two return branches — easy to drop.
 */
describe("the status route reports existence", () => {
  const source = readFileSync("src/app/api/sessions/[id]/status/route.ts", "utf8");

  it("reports it on both branches", () => {
    expect(source).toContain("exists: false");
    expect(source).toContain("exists: true");
  });

  it("still tolerates a session that is mid-creation", () => {
    // Removing allowMissing would make the missing-record branch unreachable
    // again, and `exists: false` would never be sent.
    expect(source).toContain("allowMissing: true");
  });
});
