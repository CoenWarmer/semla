/**
 * Without these records a transcript is readable but unreachable: the sidebar
 * is empty and the page has no title, because everything needed to *find* a
 * session lived only in Postgres.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  hasTranscript,
  listSessionMeta,
  readSessionMeta,
  writeSessionMeta,
} from "./session-meta.ts";

const dir = () => mkdtempSync(join(tmpdir(), "semla-meta-"));

describe("writeSessionMeta", () => {
  it("creates a record and reads it back", () => {
    const d = dir();

    writeSessionMeta("s1", { title: "Orient semla", projectPath: "/Dev/semla" }, d);

    const meta = readSessionMeta("s1", d)!;
    expect(meta.title).toBe("Orient semla");
    expect(meta.projectPath).toBe("/Dev/semla");
    expect(meta.isRunning).toBe(false);
  });

  it("merges rather than replacing, so one writer cannot erase another's field", () => {
    const d = dir();
    writeSessionMeta("s1", { title: "Orient semla", goal: "learn the repo" }, d);

    writeSessionMeta("s1", { isRunning: true }, d);

    const meta = readSessionMeta("s1", d)!;
    expect(meta.title).toBe("Orient semla");
    expect(meta.goal).toBe("learn the repo");
    expect(meta.isRunning).toBe(true);
  });

  // A record written by an older version is still usable.
  it("fills in fields a stored record does not have", () => {
    const d = dir();
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "s1.json"), JSON.stringify({ title: "old" }), "utf8");

    const meta = readSessionMeta("s1", d)!;
    expect(meta.title).toBe("old");
    expect(meta.isRunning).toBe(false);
    expect(meta.id).toBe("s1");
  });

  it("has no record for an unknown session", () => {
    expect(readSessionMeta("nope", dir())).toBeNull();
  });

  it("survives a corrupt record instead of throwing", () => {
    const d = dir();
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "s1.json"), "{ truncated", "utf8");

    expect(readSessionMeta("s1", d)).toBeNull();
  });
});

describe("listSessionMeta", () => {
  it("lists sessions newest first", () => {
    const d = dir();
    writeSessionMeta("older", { createdAt: "2026-08-30T10:00:00.000Z" }, d);
    writeSessionMeta("newer", { createdAt: "2026-08-31T10:00:00.000Z" }, d);

    expect(listSessionMeta(d).map((m) => m.id)).toEqual(["newer", "older"]);
  });

  it("ignores transcripts and anything that is not a record", () => {
    const d = dir();
    writeSessionMeta("s1", {}, d);
    writeFileSync(join(d, "s1.jsonl"), "{}\n", "utf8");
    writeFileSync(join(d, "notes.txt"), "x", "utf8");

    expect(listSessionMeta(d).map((m) => m.id)).toEqual(["s1"]);
  });

  it("is empty when the directory does not exist yet", () => {
    expect(listSessionMeta(join(tmpdir(), "semla-absent-dir"))).toEqual([]);
  });
});

describe("hasTranscript", () => {
  it("distinguishes a written transcript from an empty or missing one", () => {
    const d = dir();
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "full.jsonl"), '{"type":"session"}\n', "utf8");
    writeFileSync(join(d, "empty.jsonl"), "", "utf8");

    expect(hasTranscript("full", d)).toBe(true);
    expect(hasTranscript("empty", d)).toBe(false);
    expect(hasTranscript("missing", d)).toBe(false);
  });
});
