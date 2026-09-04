/**
 * Phase 1 of docs/plans/session-isolation.md: intersecting the live registry
 * with each session's project links, so "who else is working here" is a fact
 * rather than a guess.
 */
import { afterEach, describe, expect, it } from "vitest";

import { releaseLiveSession, retainLiveSession } from "./live-sessions.ts";
import {
  otherActiveSessionCount,
  otherActiveSessionsByProject,
} from "./session-concurrency.ts";
import type { SessionMeta } from "./session-meta.ts";

const session = () => ({ abort: async () => {} });

const link = (path: string) => ({
  path,
  origin: "explicit" as const,
  isPrimary: true,
  firstAttachedAt: "2026-09-01T10:00:00.000Z",
  lastTouchedAt: "2026-09-01T10:00:00.000Z",
});

const meta = (id: string, projects: string[]): SessionMeta => ({
  id,
  title: null,
  goal: null,
  projects: projects.map(link),
  isRunning: false,
  createdAt: "2026-09-01T10:00:00.000Z",
  userId: null,
});

afterEach(() => {
  for (const id of ["a", "b", "c"]) releaseLiveSession(id);
});

describe("otherActiveSessionsByProject", () => {
  it("is empty when no other session is running", () => {
    const all = [meta("a", ["semla"]), meta("b", ["semla"])];

    expect(otherActiveSessionsByProject(["semla"], "a", all)).toEqual({
      semla: [],
    });
  });

  it("names a running session sharing the project, not one that only shares it while idle", () => {
    retainLiveSession("b", session());
    const all = [meta("a", ["semla"]), meta("b", ["semla"]), meta("c", ["semla"])];

    expect(otherActiveSessionsByProject(["semla"], "a", all)).toEqual({
      semla: ["b"],
    });
  });

  it("never counts the querying session itself, even if it is somehow live", () => {
    retainLiveSession("a", session());
    const all = [meta("a", ["semla"])];

    expect(otherActiveSessionsByProject(["semla"], "a", all)).toEqual({
      semla: [],
    });
  });

  it("excludes a running session working in a different project", () => {
    retainLiveSession("b", session());
    const all = [meta("a", ["semla"]), meta("b", ["kibana"])];

    expect(otherActiveSessionsByProject(["semla"], "a", all)).toEqual({
      semla: [],
    });
  });

  it("answers per project for a session linked to several", () => {
    retainLiveSession("b", session());
    retainLiveSession("c", session());
    const all = [
      meta("a", ["semla", "kibana"]),
      meta("b", ["semla"]),
      meta("c", ["kibana"]),
    ];

    expect(otherActiveSessionsByProject(["semla", "kibana"], "a", all)).toEqual({
      semla: ["b"],
      kibana: ["c"],
    });
  });
});

describe("otherActiveSessionCount", () => {
  it("is a plain count for one project", () => {
    retainLiveSession("b", session());
    retainLiveSession("c", session());
    const all = [meta("a", ["semla"]), meta("b", ["semla"]), meta("c", ["semla"])];

    expect(otherActiveSessionCount("semla", "a", all)).toBe(2);
  });

  it("is zero for a project no other session is tracked against", () => {
    expect(otherActiveSessionCount("nonexistent", "a", [])).toBe(0);
  });
});
