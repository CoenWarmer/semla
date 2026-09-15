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

const customMessage = (
  id: string,
  at: string,
  parentId: string | null,
  customType: string,
  content: string,
) => ({
  id,
  type: "custom_message",
  customType,
  parentId,
  timestamp: at,
  content,
  display: false,
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

  it("attaches the earlier wording of an edited message", () => {
    const d = dir();
    write(d, "s1", [
      header,
      message("a", "2026-08-31T09:00:01.000Z", null, "ask"),
      message("b1", "2026-08-31T09:00:02.000Z", "a", "first wording"),
      message("r1", "2026-08-31T09:00:03.000Z", "b1", "reply to the first"),
      message("b2", "2026-08-31T09:00:04.000Z", "a", "second wording"),
    ]);

    const rows = readSessionEntries("s1", d)!;
    const live = rows.find((row) => row.id === "b2")!;

    // The earlier prompt, not the reply it drew — that subtree is not history
    // of this message.
    expect(live.superseded).toHaveLength(1);
    expect(
      (live.superseded![0].message as { content: { text: string }[] }).content[0].text,
    ).toBe("first wording");
  });

  it("attaches nothing where a message was never edited", () => {
    const d = dir();
    write(d, "s1", [
      header,
      message("a", "2026-08-31T09:00:01.000Z", null),
      message("b", "2026-08-31T09:00:02.000Z", "a"),
    ]);

    expect(readSessionEntries("s1", d)!.every((row) => row.superseded === undefined)).toBe(
      true,
    );
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

  it("attaches wiki auto-recall content to the message it was injected after", () => {
    // The real shape: pi-llm-wiki's before_agent_start hook parents the recall
    // entry to the user message that triggered it, with display: false — a
    // TUI-rendering hint, not license to drop it from Semla's own record.
    const d = dir();
    write(d, "s1", [
      header,
      message("a", "2026-08-31T09:00:01.000Z", null, "what does this do?"),
      customMessage(
        "r",
        "2026-08-31T09:00:01.500Z",
        "a",
        "wiki-recall-context",
        "## Relevant Wiki Knowledge\n\n1. [[concepts/foo]]",
      ),
      message("b", "2026-08-31T09:00:02.000Z", "r", "the answer"),
    ]);

    const rows = readSessionEntries("s1", d)!;

    // The custom_message entry itself is still not a message row — only its
    // content, attributed to "a".
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(rows.find((r) => r.id === "a")!.wikiRecall).toBe(
      "## Relevant Wiki Knowledge\n\n1. [[concepts/foo]]",
    );
    expect(rows.find((r) => r.id === "b")!.wikiRecall).toBeUndefined();
  });

  it("ignores a custom_message of a different customType", () => {
    // The exclusion in "skips the session header and non-message entries"
    // above still holds for anything that is not the wiki's own recall type —
    // this is not a blanket amnesty for every extension's custom messages.
    const d = dir();
    write(d, "s1", [
      header,
      message("a", "2026-08-31T09:00:01.000Z", null),
      customMessage(
        "c",
        "2026-08-31T09:00:01.500Z",
        "a",
        "wiki-session-notice",
        "Wiki active",
      ),
      message("b", "2026-08-31T09:00:02.000Z", "c"),
    ]);

    const rows = readSessionEntries("s1", d)!;
    expect(rows.every((row) => row.wikiRecall === undefined)).toBe(true);
  });

  it("walks past the wiki's own session-notice to find the triggering message", () => {
    // The actual regression: on a session's FIRST turn, pi-llm-wiki's
    // session_start hook has already queued its own wiki-session-notice
    // custom_message, so the real on-disk chain is
    // user -> wiki-session-notice -> wiki-recall-context -> assistant. The
    // recall entry's direct parentId is the notice, not the user message —
    // matching only the immediate parent found nothing here, so the badge
    // that appeared live (driven by message order, not parentId) vanished the
    // moment the turn ended and this chain replaced it.
    const d = dir();
    write(d, "s1", [
      header,
      message("a", "2026-08-31T09:00:01.000Z", null, "what does this do?"),
      customMessage(
        "notice",
        "2026-08-31T09:00:01.200Z",
        "a",
        "wiki-session-notice",
        "Wiki active",
      ),
      customMessage(
        "r",
        "2026-08-31T09:00:01.500Z",
        "notice",
        "wiki-recall-context",
        "## Relevant Wiki Knowledge\n\n1. [[concepts/foo]]",
      ),
      message("b", "2026-08-31T09:00:02.000Z", "r", "the answer"),
    ]);

    const rows = readSessionEntries("s1", d)!;

    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(rows.find((r) => r.id === "a")!.wikiRecall).toBe(
      "## Relevant Wiki Knowledge\n\n1. [[concepts/foo]]",
    );
  });

  it("does not attribute recall to anything when its ancestor chain never reaches a message", () => {
    // A malformed or truncated file must not crash the walk or misattribute
    // the content to an unrelated earlier message.
    const d = dir();
    write(d, "s1", [
      header,
      customMessage(
        "r",
        "2026-08-31T09:00:01.500Z",
        "missing-parent",
        "wiki-recall-context",
        "## Relevant Wiki Knowledge",
      ),
      message("a", "2026-08-31T09:00:02.000Z", null, "hello"),
    ]);

    const rows = readSessionEntries("s1", d)!;
    expect(rows.every((row) => row.wikiRecall === undefined)).toBe(true);
  });

  it("walks to a named leaf instead of the default when leafId is given", () => {
    const d = dir();
    write(d, "s1", [
      header,
      message("a", "2026-08-31T09:00:01.000Z", null, "first ask"),
      message("b1", "2026-08-31T09:00:02.000Z", "a", "abandoned reply"),
      message("c1", "2026-08-31T09:00:03.000Z", "b1", "abandoned follow-up"),
      message("b2", "2026-08-31T09:00:04.000Z", "a", "edited ask"),
      message("c2", "2026-08-31T09:00:05.000Z", "b2", "live reply"),
    ]);

    // Naming the abandoned branch's own tip surfaces it instead of the default.
    expect(readSessionEntries("s1", d, "c1")!.map((r) => r.id)).toEqual([
      "a",
      "b1",
      "c1",
    ]);
  });

  it("falls back to the default leaf for an id the session does not recognise", () => {
    const d = dir();
    write(d, "s1", [
      header,
      message("a", "2026-08-31T09:00:01.000Z"),
      message("b", "2026-08-31T09:00:02.000Z", "a"),
    ]);

    expect(readSessionEntries("s1", d, "unknown")!.map((r) => r.id)).toEqual([
      "a",
      "b",
    ]);
  });
});
