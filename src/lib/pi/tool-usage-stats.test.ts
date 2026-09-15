/**
 * Fixtures follow session-file.test.ts's pattern: a real .jsonl per session,
 * parented entries, so this exercises the actual on-disk shape rather than a
 * hand-built TranscriptRow[].
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { computeToolUsageStats } from "./tool-usage-stats.ts";
import type { SessionMeta } from "./session/session-meta.ts";

const dir = () => mkdtempSync(join(tmpdir(), "semla-toolusage-"));

const write = (d: string, id: string, lines: unknown[]) => {
  mkdirSync(d, { recursive: true });
  writeFileSync(
    join(d, `${id}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    "utf8",
  );
};

const header = (id: string) => ({
  type: "session",
  id,
  version: 3,
  timestamp: "2026-08-31T09:00:00.000Z",
});

const userMessage = (id: string, at: string, parentId: string | null, text = "hi") => ({
  id,
  type: "message",
  parentId,
  timestamp: at,
  message: { role: "user", content: [{ type: "text", text }] },
});

const assistantWithToolCalls = (
  id: string,
  at: string,
  parentId: string | null,
  calls: { id: string; name: string }[],
) => ({
  id,
  type: "message",
  parentId,
  timestamp: at,
  message: {
    role: "assistant",
    content: calls.map((c) => ({ type: "toolCall", id: c.id, name: c.name })),
  },
});

const toolResult = (
  id: string,
  at: string,
  parentId: string | null,
  toolCallId: string,
  isError: boolean,
) => ({
  id,
  type: "message",
  parentId,
  timestamp: at,
  message: {
    role: "toolResult",
    toolCallId,
    isError,
    content: [{ type: "text", text: isError ? "boom" : "ok" }],
  },
});

const meta = (id: string, createdAt: string): SessionMeta => ({
  id,
  title: null,
  goal: null,
  projects: [],
  isRunning: false,
  createdAt,
  userId: "u1",
});

describe("computeToolUsageStats", () => {
  it("tallies tool calls by name across sessions, counting failures separately", () => {
    const d = dir();
    write(d, "s1", [
      header("s1"),
      userMessage("a", "2026-09-01T09:00:00.000Z", null),
      assistantWithToolCalls("b", "2026-09-01T09:00:01.000Z", "a", [
        { id: "t1", name: "read" },
        { id: "t2", name: "bash" },
      ]),
      toolResult("c", "2026-09-01T09:00:02.000Z", "b", "t1", false),
      toolResult("d", "2026-09-01T09:00:03.000Z", "b", "t2", true),
    ]);
    write(d, "s2", [
      header("s2"),
      userMessage("a", "2026-09-01T10:00:00.000Z", null),
      assistantWithToolCalls("b", "2026-09-01T10:00:01.000Z", "a", [
        { id: "t1", name: "read" },
      ]),
      toolResult("c", "2026-09-01T10:00:02.000Z", "b", "t1", false),
    ]);

    const sessions = [meta("s1", "2026-09-01T09:00:00.000Z"), meta("s2", "2026-09-01T10:00:00.000Z")];
    const buckets = computeToolUsageStats(
      sessions,
      { from: new Date("2026-09-01T00:00:00.000Z"), to: new Date("2026-09-02T00:00:00.000Z") },
      d,
    );

    expect(buckets).toEqual([
      { toolName: "read", count: 2, failedCount: 0 },
      { toolName: "bash", count: 1, failedCount: 1 },
    ]);
  });

  it("excludes sessions whose createdAt falls outside the range", () => {
    const d = dir();
    write(d, "s1", [
      header("s1"),
      userMessage("a", "2026-09-01T09:00:00.000Z", null),
      assistantWithToolCalls("b", "2026-09-01T09:00:01.000Z", "a", [{ id: "t1", name: "read" }]),
      toolResult("c", "2026-09-01T09:00:02.000Z", "b", "t1", false),
    ]);

    const sessions = [meta("s1", "2026-01-01T00:00:00.000Z")];
    const buckets = computeToolUsageStats(
      sessions,
      { from: new Date("2026-09-01T00:00:00.000Z"), to: new Date("2026-09-02T00:00:00.000Z") },
      d,
    );

    expect(buckets).toEqual([]);
  });

  it("returns an empty list when no sessions are given", () => {
    const buckets = computeToolUsageStats(
      [],
      { from: new Date("2026-09-01T00:00:00.000Z"), to: new Date("2026-09-02T00:00:00.000Z") },
      dir(),
    );
    expect(buckets).toEqual([]);
  });
});
