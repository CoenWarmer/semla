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

/**
 * Entries chain through `parentId`, as Pi writes them. Fixtures that leave every
 * entry parentless are not just unrealistic, they are unreadable: the file is a
 * tree, and a forest of orphans has no path through it.
 */
const message = (id: string, at: string, parentId: string | null = null, text = "hello") => ({
  id,
  type: "message",
  parentId,
  timestamp: at,
  message: { role: "user", content: [{ type: "text", text }] },
});

const other = (type: string, id: string, at: string, parentId: string | null) => ({
  id,
  type,
  parentId,
  timestamp: at,
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
      other("model_change", "m", "2026-08-31T09:00:00.500Z", null),
      message("a", "2026-08-31T09:00:01.000Z", "m"),
      other("custom_message", "c", "2026-08-31T09:00:02.000Z", "a"),
    ]);

    expect(readSessionEntries("s1", d)!.map((r) => r.id)).toEqual(["a"]);
  });

  it("keeps a message whose parent is not itself a message", () => {
    // The chain runs through entries of every type. Filtering to messages before
    // walking would cut it here and strand everything above the gap.
    const d = dir();
    write(d, "s1", [
      header,
      message("a", "2026-08-31T09:00:01.000Z", null),
      other("branch_summary", "s", "2026-08-31T09:00:02.000Z", "a"),
      message("b", "2026-08-31T09:00:03.000Z", "s"),
    ]);

    expect(readSessionEntries("s1", d)!.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("returns only the live path when the session has branched", () => {
    // The bug this replaced: every line was returned, so an edited or compacted
    // session showed the abandoned attempts alongside the real conversation.
    const d = dir();
    write(d, "s1", [
      header,
      message("a", "2026-08-31T09:00:01.000Z", null, "first ask"),
      message("b1", "2026-08-31T09:00:02.000Z", "a", "abandoned reply"),
      message("c1", "2026-08-31T09:00:03.000Z", "b1", "abandoned follow-up"),
      message("b2", "2026-08-31T09:00:04.000Z", "a", "edited ask"),
      message("c2", "2026-08-31T09:00:05.000Z", "b2", "live reply"),
    ]);

    expect(readSessionEntries("s1", d)!.map((r) => r.id)).toEqual(["a", "b2", "c2"]);
  });

  it("carries parentId through, so superseded versions stay findable", () => {
    const d = dir();
    write(d, "s1", [
      header,
      message("a", "2026-08-31T09:00:01.000Z", null),
      message("b", "2026-08-31T09:00:02.000Z", "a"),
    ]);

    expect(readSessionEntries("s1", d)!.at(-1)!.payload.entry.parentId).toBe("a");
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
