/**
 * The two halves of the session→repo contract have to agree, and nothing else
 * makes them.
 *
 * wiki-session-repo.ts writes the slot through Next's module graph;
 * wiki-ingest-bridge.ts reads the same `globalThis` slot directly, because jiti
 * cannot resolve the "@/" alias the writer uses. There is no import edge
 * between them, so a change to one shape is invisible to the other — and the
 * failure is not a crash but a wrongly-tagged wiki page, discovered weeks later
 * in a vault nobody wants to re-derive.
 *
 * These tests read the slot the way the bridge does, on purpose.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { readOrInitSlot, WIKI_SESSION_REPOS } from "@/lib/pi/extension-contract";
import {
  clearSessionRepo,
  getSessionRepos,
  setSessionRepos,
} from "@/lib/pi/wiki-session-repo";

/** Exactly what wiki-ingest-bridge.ts does, minus the alias it cannot use. */
const bridgeReads = (sessionId: string): string[] =>
  readOrInitSlot(WIKI_SESSION_REPOS, () => new Map()).get(sessionId) ?? [];

describe("session repo slot", () => {
  beforeEach(() => {
    for (const id of ["s1", "s2"]) clearSessionRepo(id);
  });

  it("publishes a list the bridge can read", () => {
    setSessionRepos("s1", ["semla"]);

    expect(getSessionRepos("s1")).toEqual(["semla"]);
    expect(bridgeReads("s1")).toEqual(["semla"]);
  });

  it("carries every repo a turn is attributed to", () => {
    setSessionRepos("s1", ["semla", "catalog-info"]);

    expect(bridgeReads("s1")).toEqual(["semla", "catalog-info"]);
  });

  it("republishes rather than accumulating, so a turn's set replaces the last", () => {
    setSessionRepos("s1", ["semla"]);
    setSessionRepos("s1", ["semla", "kibana"]);

    expect(bridgeReads("s1")).toEqual(["semla", "kibana"]);
  });

  it("drops duplicates", () => {
    setSessionRepos("s1", ["semla", "semla"]);

    expect(bridgeReads("s1")).toEqual(["semla"]);
  });

  it("clears the entry for an empty set rather than recording one", () => {
    // A session that loses its projects must stop attributing pages to the ones
    // it used to have.
    setSessionRepos("s1", ["semla"]);
    setSessionRepos("s1", []);

    expect(getSessionRepos("s1")).toEqual([]);
    expect(bridgeReads("s1")).toEqual([]);
  });

  it("keeps sessions apart, which is why the slot is keyed at all", () => {
    // Concurrent orients live in one process; a single shared value was how 168
    // pages once ended up attributed to whichever session started last.
    setSessionRepos("s1", ["semla"]);
    setSessionRepos("s2", ["kibana"]);

    expect(bridgeReads("s1")).toEqual(["semla"]);
    expect(bridgeReads("s2")).toEqual(["kibana"]);
  });

  it("reports nothing for a session that never published", () => {
    expect(getSessionRepos("unknown")).toEqual([]);
    expect(getSessionRepos(undefined)).toEqual([]);
  });

  it("forgets a finished session", () => {
    setSessionRepos("s1", ["semla"]);
    clearSessionRepo("s1");

    expect(bridgeReads("s1")).toEqual([]);
  });
});
