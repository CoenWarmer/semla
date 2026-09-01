/**
 * The sidebar and the session page cache session state under the same key
 * prefix. They used to have their own fetchers — one returning the array, one
 * the whole response — so whichever populated the cache first decided the
 * shape, and the other read a field that was not there and crashed the session
 * page.
 *
 * There are two questions now, list and single, because they cost very
 * different amounts to answer. The rule survives the split: within each
 * question, one key, one fetcher.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchSessionStatus,
  fetchSingleSessionStatus,
} from "./session-status.ts";

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

describe("fetchSingleSessionStatus", () => {
  it("returns one session's state, with no envelope to unwrap", () => {
    respondWith({ isRunning: true, projects: [] });

    return expect(fetchSingleSessionStatus("abc")).resolves.toEqual({
      isRunning: true,
      projects: [],
    });
  });

  it("throws rather than caching a shape nobody can read", () => {
    respondWith({ error: "nope" }, false);

    return expect(fetchSingleSessionStatus("abc")).rejects.toThrow(
      "Unable to load session status.",
    );
  });
});

/**
 * The guard that matters: one key, one fetcher. Two useQuery calls on the same
 * key with different queryFns is what broke, and it type-checks perfectly.
 *
 * Asserted against the source because the failure is a *pairing* — a key with
 * the wrong fetcher beside it — which no type can express.
 */
describe("consumers of session status", () => {
  const read = (file: string) =>
    readFileSync(join(process.cwd(), file), "utf8");

  // Wants every session: the sidebar surfaces ones the server render missed.
  const listConsumers = ["src/components/sessions-list-client.tsx"];

  // Wants one session, already named in the URL.
  const singleConsumers = [
    "src/hooks/use-prompt-mutation.ts",
    "src/components/header-actions.tsx",
  ];

  it.each(listConsumers)("%s queries the list through its shared fetcher", (file) => {
    const source = read(file);

    expect(source).toContain("queryKey: SESSION_STATUS_KEY");
    expect(
      source.includes("queryFn: fetchSessionStatus"),
      `${file} uses SESSION_STATUS_KEY with its own queryFn. One key has to ` +
        "mean one shape, or whichever request lands first decides it.",
    ).toBe(true);
  });

  it.each(singleConsumers)("%s queries one session, not the list", (file) => {
    const source = read(file);

    expect(source).toContain("queryKey: sessionStatusKey(sessionId)");
    expect(
      source.includes("fetchSingleSessionStatus(sessionId)"),
      `${file} uses sessionStatusKey with its own queryFn.`,
    ).toBe(true);
  });

  it.each(singleConsumers)(
    "%s does not pull the whole list to find one session",
    (file) => {
      const source = read(file);
      // The regression this split exists to prevent: loading 136 sessions to
      // read one field off the one already named in the URL.
      expect(source).not.toContain("queryFn: fetchSessionStatus");
    },
  );

  it.each([...listConsumers, ...singleConsumers])(
    "%s does not define a local status fetcher",
    (file) => {
      expect(read(file)).not.toMatch(/fetch\(["'`]\/api\/sessions\/status/);
    },
  );
});
