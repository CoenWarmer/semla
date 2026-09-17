import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  appendSpecTurn,
  parseSpecMarker,
  readSpecLog,
  renderSpecLog,
  shouldConsiderDistillation,
  specLogPath,
} from "./spec-log";

describe("parseSpecMarker", () => {
  it("detects a leading @spec marker and strips it", () => {
    expect(parseSpecMarker("@spec always use tabs")).toEqual({
      loadBearing: true,
      text: "always use tabs",
    });
  });

  it("is case-insensitive on the marker itself", () => {
    expect(parseSpecMarker("@SPEC always use tabs").loadBearing).toBe(true);
  });

  it("does not treat a mid-message mention as the marker", () => {
    expect(parseSpecMarker("please read @spec docs")).toEqual({
      loadBearing: false,
      text: "please read @spec docs",
    });
  });

  it("passes through ordinary text unchanged", () => {
    expect(parseSpecMarker("just a normal message")).toEqual({
      loadBearing: false,
      text: "just a normal message",
    });
  });
});

describe("appendSpecTurn / readSpecLog", () => {
  let dir: string;

  afterEach(() => {
    if (dir && existsSync(dir)) rmSync(dir, { force: true, recursive: true });
  });

  it("is append-only: later turns never overwrite earlier ones", () => {
    dir = mkdtempSync(join(tmpdir(), "spec-log-test-"));
    const sessionId = "session-1";

    appendSpecTurn(dir, sessionId, {
      loadBearing: false,
      text: "first constraint",
      timestamp: "2026-01-01T00:00:00.000Z",
      turnId: null,
      turnIndex: 0,
    });
    appendSpecTurn(dir, sessionId, {
      loadBearing: false,
      text: "second constraint, contradicts the first",
      timestamp: "2026-01-01T00:01:00.000Z",
      turnId: null,
      turnIndex: 1,
    });

    const turns = readSpecLog(dir, sessionId);

    expect(turns).toHaveLength(2);
    expect(turns[0].text).toBe("first constraint");
    expect(turns[1].text).toBe("second constraint, contradicts the first");
  });

  it("round-trips the @spec marker", () => {
    dir = mkdtempSync(join(tmpdir(), "spec-log-test-"));
    const sessionId = "session-2";

    appendSpecTurn(dir, sessionId, {
      loadBearing: true,
      text: "always use tabs",
      timestamp: "2026-01-01T00:00:00.000Z",
      turnId: null,
      turnIndex: 0,
    });

    expect(readSpecLog(dir, sessionId)).toEqual([
      {
        loadBearing: true,
        text: "always use tabs",
        timestamp: "2026-01-01T00:00:00.000Z",
        turnId: null,
        turnIndex: 0,
      },
    ]);
  });

  it("round-trips a line carrying a turnId", () => {
    dir = mkdtempSync(join(tmpdir(), "spec-log-test-"));
    const sessionId = "session-2b";

    appendSpecTurn(dir, sessionId, {
      loadBearing: false,
      text: "use the new join",
      timestamp: "2026-01-01T00:00:00.000Z",
      turnId: "20260101T000000000Z-aaaaaaaa",
      turnIndex: 0,
    });

    expect(readSpecLog(dir, sessionId)[0].turnId).toBe(
      "20260101T000000000Z-aaaaaaaa",
    );
  });

  it("parses an old-format line (no [id:...] tag) with turnId null", () => {
    dir = mkdtempSync(join(tmpdir(), "spec-log-test-"));
    const sessionId = "session-2c";

    writeFileSync(
      specLogPath(dir, sessionId),
      "[turn 0] [2026-01-01T00:00:00.000Z] [@spec] \u2014 old format line\n",
    );

    const turns = readSpecLog(dir, sessionId);
    expect(turns).toHaveLength(1);
    expect(turns[0].turnId).toBeNull();
    expect(turns[0].loadBearing).toBe(true);
    expect(turns[0].text).toBe("old format line");
  });

  it("escapes and restores embedded newlines so one turn is one line on disk", () => {
    dir = mkdtempSync(join(tmpdir(), "spec-log-test-"));
    const sessionId = "session-3";

    appendSpecTurn(dir, sessionId, {
      loadBearing: false,
      text: "line one\nline two",
      timestamp: "2026-01-01T00:00:00.000Z",
      turnId: null,
      turnIndex: 0,
    });

    const raw = readFileSync(specLogPath(dir, sessionId), "utf-8");
    expect(raw.split("\n").filter(Boolean)).toHaveLength(1);

    expect(readSpecLog(dir, sessionId)[0].text).toBe("line one\nline two");
  });

  it("returns an empty array when the file is absent", () => {
    dir = mkdtempSync(join(tmpdir(), "spec-log-test-"));
    expect(readSpecLog(dir, "no-such-session")).toEqual([]);
  });
});

describe("renderSpecLog", () => {
  it("hoists @spec turns before chronological ones, later chronological order preserved", () => {
    const rendered = renderSpecLog([
      { loadBearing: false, text: "first", timestamp: "t0", turnId: null, turnIndex: 0 },
      {
        loadBearing: true,
        text: "load-bearing constraint",
        timestamp: "t1",
        turnId: null,
        turnIndex: 1,
      },
      {
        loadBearing: false,
        text: "second, supersedes first",
        timestamp: "t2",
        turnId: null,
        turnIndex: 2,
      },
    ]);

    const loadBearingIndex = rendered.indexOf("load-bearing constraint");
    const firstIndex = rendered.indexOf("first");
    const secondIndex = rendered.indexOf("second, supersedes first");

    expect(loadBearingIndex).toBeGreaterThanOrEqual(0);
    expect(loadBearingIndex).toBeLessThan(firstIndex);
    expect(firstIndex).toBeLessThan(secondIndex);
  });

  it("returns an empty string for no turns", () => {
    expect(renderSpecLog([])).toBe("");
  });

  it("never injects the turnId into the rendered output", () => {
    const rendered = renderSpecLog([
      {
        loadBearing: false,
        text: "a requirement",
        timestamp: "t0",
        turnId: "20260101T000000000Z-aaaaaaaa",
        turnIndex: 0,
      },
    ]);
    expect(rendered).not.toContain("20260101T000000000Z-aaaaaaaa");
  });
});

describe("shouldConsiderDistillation", () => {
  it("is false under the threshold", () => {
    const turns = Array.from({ length: 10 }, (_, i) => ({
      loadBearing: false,
      text: `turn ${i}`,
      timestamp: "t",
      turnId: null,
      turnIndex: i,
    }));
    expect(shouldConsiderDistillation(turns)).toBe(false);
  });

  it("is true over the threshold", () => {
    const turns = Array.from({ length: 41 }, (_, i) => ({
      loadBearing: false,
      text: `turn ${i}`,
      timestamp: "t",
      turnId: null,
      turnIndex: i,
    }));
    expect(shouldConsiderDistillation(turns)).toBe(true);
  });
});
