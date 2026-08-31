/**
 * Pi writes the session file as the conversation happens, so it is complete
 * before Postgres has been told anything. Reading it is what lets a transcript
 * survive a database outage — the history was on disk the whole time.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readSessionEntries } from "./session-file.ts";

const dir = () => mkdtempSync(join(tmpdir(), "semla-sessionfile-"));

const write = (d: string, id: string, lines: unknown[]) => {
  mkdirSync(d, { recursive: true });
  writeFileSync(
    join(d, `${id}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    "utf8",
  );
};

const header = { type: "session", id: "s1", version: 3, timestamp: "2026-08-31T09:00:00.000Z" };
const message = (id: string, at: string) => ({
  id,
  type: "message",
  parentId: null,
  timestamp: at,
  message: { role: "user", content: [{ type: "text", text: "hello" }] },
});

describe("readSessionEntries", () => {
  it("returns message entries in the shape the transcript builder expects", () => {
    const d = dir();
    write(d, "s1", [header, message("a", "2026-08-31T09:00:01.000Z")]);

    const rows = readSessionEntries("s1", d)!;

    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("a");
    // The entry timestamp, not an insertion time — the same field the database
    // path prefers for exactly this reason.
    expect(rows[0]!.created_at).toBe("2026-08-31T09:00:01.000Z");
    expect(rows[0]!.payload.entry.type).toBe("message");
  });

  it("skips the session header and non-message entries", () => {
    const d = dir();
    write(d, "s1", [
      header,
      { type: "model_change", id: "m", timestamp: "2026-08-31T09:00:00.500Z" },
      message("a", "2026-08-31T09:00:01.000Z"),
      { type: "custom_message", id: "c", timestamp: "2026-08-31T09:00:02.000Z" },
    ]);

    expect(readSessionEntries("s1", d)!.map((r) => r.id)).toEqual(["a"]);
  });

  // A crash mid-append leaves a partial final line; losing one entry beats
  // losing the conversation.
  it("skips an unparseable trailing line", () => {
    const d = dir();
    mkdirSync(d, { recursive: true });
    writeFileSync(
      join(d, "s1.jsonl"),
      [JSON.stringify(header), JSON.stringify(message("a", "t")), '{"type":"mess'].join("\n"),
      "utf8",
    );

    expect(readSessionEntries("s1", d)!.map((r) => r.id)).toEqual(["a"]);
  });

  // Null and empty mean different things: no file falls back to Postgres, a
  // file with no messages is a real, empty transcript.
  it("returns null when there is no file", () => {
    expect(readSessionEntries("missing", dir())).toBeNull();
  });

  it("returns null for an empty file rather than an empty transcript", () => {
    const d = dir();
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "s1.jsonl"), "", "utf8");

    expect(readSessionEntries("s1", d)).toBeNull();
  });

  it("returns an empty array for a file holding only a header", () => {
    const d = dir();
    write(d, "s1", [header]);

    expect(readSessionEntries("s1", d)).toEqual([]);
  });
});
