/**
 * The sidebar and the session page cache this under the same query key. They
 * used to have their own fetchers — one returning the array, one the whole
 * response — so whichever populated the cache first decided the shape, and the
 * other read a field that was not there and crashed the session page.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchSessionStatus, SESSION_STATUS_KEY } from "./session-status.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

const respondWith = (body: unknown, ok = true) => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok, json: async () => body }),
  );
};

describe("fetchSessionStatus", () => {
  it("returns the sessions array, not the envelope", () => {
    respondWith({ sessions: [{ id: "a", isRunning: true }] });

    return expect(fetchSessionStatus()).resolves.toEqual([
      { id: "a", isRunning: true },
    ]);
  });

  it("throws rather than caching a shape nobody can read", () => {
    respondWith({ error: "nope" }, false);

    return expect(fetchSessionStatus()).rejects.toThrow(
      "Unable to load session status.",
    );
  });
});

/**
 * The guard that matters: one key, one fetcher. Two useQuery calls on the same
 * key with different queryFns is what broke, and it type-checks perfectly.
 */
describe("consumers of the session status key", () => {
  const read = (file: string) =>
    readFileSync(join(process.cwd(), file), "utf8");

  const consumers = [
    "src/components/sessions-list-client.tsx",
    "src/hooks/use-prompt-mutation.ts",
  ];

  it.each(consumers)("%s queries it through the shared fetcher", (file) => {
    const source = read(file);

    expect(source).toContain("queryKey: SESSION_STATUS_KEY");
    expect(
      source.includes("queryFn: fetchSessionStatus"),
      `${file} uses SESSION_STATUS_KEY with its own queryFn. One key has to ` +
        "mean one shape, or whichever request lands first decides it.",
    ).toBe(true);
  });

  it.each(consumers)("%s does not define a local status fetcher", (file) => {
    expect(read(file)).not.toMatch(/fetch\(["'`]\/api\/sessions\/status/);
  });
});
