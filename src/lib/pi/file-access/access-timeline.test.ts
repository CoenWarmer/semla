import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { buildFileAccessTimeline } from "./access-timeline.ts";

const SESSION = "11111111-2222-3333-4444-555555555555";

let dir: string;

/** A pi session file: a header, then one entry per line, parent-linked. */
function writeSession(entries: unknown[]): void {
  const lines = [
    JSON.stringify({ cwd: "/ws", id: SESSION, type: "session", version: 3 }),
    ...entries.map((entry) => JSON.stringify(entry)),
  ];
  writeFileSync(join(dir, `${SESSION}.jsonl`), `${lines.join("\n")}\n`, "utf8");
}

function writeMeta(projects: string[]): void {
  writeFileSync(
    join(dir, `${SESSION}.json`),
    JSON.stringify({
      id: SESSION,
      projects: projects.map((path) => ({
        firstAttachedAt: "",
        isPrimary: true,
        lastTouchedAt: "",
        origin: "explicit",
        path,
      })),
    }),
    "utf8",
  );
}

const user = (id: string, parentId: string | null, at: string) => ({
  id,
  message: { content: "do the thing", role: "user" },
  parentId,
  timestamp: at,
  type: "message",
});

const assistant = (
  id: string,
  parentId: string,
  at: string,
  content: unknown[],
) => ({ id, message: { content, role: "assistant" }, parentId, timestamp: at, type: "message" });

const result = (
  id: string,
  parentId: string,
  callId: string,
  toolName: string,
  details: unknown,
) => ({
  id,
  message: { content: [], details, role: "toolResult", toolCallId: callId, toolName },
  parentId,
  timestamp: "2026-01-01T00:00:03.000Z",
  type: "message",
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "semla-access-"));
  writeMeta(["semla"]);
});

const build = () =>
  buildFileAccessTimeline(SESSION, {
    dir,
    exists: () => true,
    workspaceRoot: "/ws",
  });

describe("buildFileAccessTimeline", () => {
  it("returns nothing for a session with no file", () => {
    expect(build()).toEqual({ accesses: [], agents: [], turns: [] });
  });

  it("attributes accesses to the turn they happened in", () => {
    writeSession([
      user("u1", null, "2026-01-01T00:00:00.000Z"),
      assistant("a1", "u1", "2026-01-01T00:00:01.000Z", [
        { arguments: { path: "src/a.ts" }, id: "c1", name: "read", type: "toolCall" },
      ]),
      user("u2", "a1", "2026-01-01T00:00:10.000Z"),
      assistant("a2", "u2", "2026-01-01T00:00:11.000Z", [
        { arguments: { path: "src/b.ts" }, id: "c2", name: "read", type: "toolCall" },
      ]),
    ]);

    const timeline = build();
    expect(timeline.accesses.map((a) => [a.path, a.turnId])).toEqual([
      ["src/a.ts", "u1"],
      ["src/b.ts", "u2"],
    ]);
    expect(timeline.turns.map((turn) => turn.id)).toEqual(["u1", "u2"]);
  });

  it("pairs an edit with the details on its result entry", () => {
    // The whole reason this is derived server-side: `firstChangedLine` is on
    // the result, and the transcript the client gets drops `details` entirely.
    writeSession([
      user("u1", null, "2026-01-01T00:00:00.000Z"),
      assistant("a1", "u1", "2026-01-01T00:00:01.000Z", [
        { arguments: { path: "src/a.ts" }, id: "c1", name: "edit", type: "toolCall" },
      ]),
      result("r1", "a1", "c1", "edit", { firstChangedLine: 42 }),
    ]);

    expect(build().accesses[0]).toMatchObject({
      kind: "write",
      ranges: [{ end: 42, start: 42 }],
    });
  });

  it("gives each file of a multi-file bash call its own id", () => {
    writeSession([
      user("u1", null, "2026-01-01T00:00:00.000Z"),
      assistant("a1", "u1", "2026-01-01T00:00:01.000Z", [
        {
          arguments: { command: "cat src/a.ts && sed -n 1,5p src/b.ts" },
          id: "c1",
          name: "bash",
          type: "toolCall",
        },
      ]),
    ]);

    const timeline = build();
    expect(timeline.accesses.map((a) => a.id)).toEqual(["c1#0", "c1#1"]);
    expect(timeline.accesses.every((a) => a.confidence === "inferred")).toBe(true);
  });

  it("keeps a single-file call on the bare tool call id", () => {
    writeSession([
      user("u1", null, "2026-01-01T00:00:00.000Z"),
      assistant("a1", "u1", "2026-01-01T00:00:01.000Z", [
        { arguments: { path: "src/a.ts" }, id: "c1", name: "read", type: "toolCall" },
      ]),
    ]);

    expect(build().accesses[0]?.id).toBe("c1");
  });

  it("attributes work before the first prompt to the synthetic root turn", () => {
    writeSession([
      assistant("a1", "", "2026-01-01T00:00:01.000Z", [
        { arguments: { path: "src/a.ts" }, id: "c1", name: "read", type: "toolCall" },
      ]),
    ]);

    expect(build().accesses[0]?.turnId).toBe("\u2039root\u203a");
  });

  it("lists the main agent only once it has touched something", () => {
    writeSession([user("u1", null, "2026-01-01T00:00:00.000Z")]);
    expect(build().agents).toEqual([]);
  });
});
