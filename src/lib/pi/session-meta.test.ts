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
  deleteSessionFiles,
  hasTranscript,
  listSessionMeta,
  readSessionMeta,
  writeSessionMeta,
  type ProjectLink,
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

  it("starts a session with no projects", () => {
    const d = dir();
    writeSessionMeta("s1", { title: "New Session" }, d);

    expect(readSessionMeta("s1", d)!.projects).toEqual([]);
  });

  it("reads a record written before projects existed as having none", () => {
    const d = dir();
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "s1.json"), JSON.stringify({ title: "old" }), "utf8");

    expect(readSessionMeta("s1", d)!.projects).toEqual([]);
  });

  // Spreading over a blank only covers a *missing* key. These are plain JSON
  // files that get hand-edited, and a present-but-wrong value would otherwise
  // reach every caller as something it cannot iterate — one bad record taking
  // out every panel that reads projects.
  it.each([
    ["null", null],
    ["an object", { semla: true }],
    ["a string", "semla"],
  ])("reads projects stored as %s as having none", (_label, value) => {
    const d = dir();
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "s1.json"), JSON.stringify({ projects: value }), "utf8");

    expect(readSessionMeta("s1", d)!.projects).toEqual([]);
  });

  /**
   * Appending is not last-writer-wins, so this asserts the property that makes
   * it safe: writeSessionMeta never yields between its read and its write, so
   * two callers cannot interleave.
   *
   * It passes trivially while the module is synchronous. That is the point —
   * it exists to fail the day someone moves it to node:fs/promises, where the
   * failure would otherwise be a silently dropped link rather than an error.
   */
  it("keeps both links when two writers append a project", async () => {
    const d = dir();
    const link = (path: string): ProjectLink => ({
      path,
      origin: "observed",
      isPrimary: false,
      firstAttachedAt: "2026-09-01T00:00:00.000Z",
      lastTouchedAt: "2026-09-01T00:00:00.000Z",
    });

    const append = async (path: string) => {
      const current = readSessionMeta("s1", d)?.projects ?? [];
      writeSessionMeta("s1", { projects: [...current, link(path)] }, d);
    };

    writeSessionMeta("s1", { title: "Two repos" }, d);
    await Promise.all([append("semla"), append("kibana")]);

    expect(readSessionMeta("s1", d)!.projects.map((p) => p.path).sort()).toEqual([
      "kibana",
      "semla",
    ]);
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

/**
 * A deleted session used to survive on disk, and since the sidebar polls the
 * directory that made it a session nobody could get rid of — it reappeared on
 * the next poll.
 */
describe("deleteSessionFiles", () => {
  it("removes the record and the transcript together", () => {
    const d = dir();
    writeSessionMeta("s1", { title: "gone" }, d);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "s1.jsonl"), '{"type":"session"}\n', "utf8");

    deleteSessionFiles("s1", d);

    expect(readSessionMeta("s1", d)).toBeNull();
    expect(hasTranscript("s1", d)).toBe(false);
    expect(listSessionMeta(d)).toEqual([]);
  });

  it("leaves other sessions alone", () => {
    const d = dir();
    writeSessionMeta("keep", {}, d);
    writeSessionMeta("drop", {}, d);

    deleteSessionFiles("drop", d);

    expect(listSessionMeta(d).map((m) => m.id)).toEqual(["keep"]);
  });

  it("is a no-op for a session that was never written", () => {
    const d = dir();

    expect(() => deleteSessionFiles("never", d)).not.toThrow();
  });
});
