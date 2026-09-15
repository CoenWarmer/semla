/**
 * `detach` is the only thing standing between a Supabase blip and a dead
 * server: the fire-and-forget writes a turn makes all reject, and an unhandled
 * rejection terminates the Node process by default. Dropping the write is fine
 * — losing it silently is not.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { detach, sessionTag } from "./session-log.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("detach", () => {
  it("absorbs a rejection instead of letting it escape", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() =>
      detach("session-1", "persist snapshot", Promise.reject(new Error("522"))),
    ).not.toThrow();
    await flush();

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("names the write that failed and why, under the session's tag", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    detach("abcdefgh-rest-of-id", "update title", Promise.reject(new Error("522")));
    await flush();

    expect(warn.mock.calls[0]![0]).toBe(
      "[pi:session:abcdefgh] update title failed: 522",
    );
  });

  // Supabase client errors are not always Errors.
  it("describes a non-Error rejection", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    detach("session-1", "clear running", Promise.reject("gateway timeout"));
    await flush();

    expect(warn.mock.calls[0]![0]).toContain("clear running failed: gateway timeout");
  });

  it("says nothing when the write succeeds", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    detach("session-1", "set running", Promise.resolve());
    await flush();

    expect(warn).not.toHaveBeenCalled();
  });
});

describe("sessionTag", () => {
  it("shortens the id to something a log line can carry", () => {
    expect(sessionTag("0f8a1c2d-9999-4444-8888-aaaaaaaaaaaa")).toBe(
      "[pi:session:0f8a1c2d]",
    );
  });
});
