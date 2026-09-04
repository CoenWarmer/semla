/**
 * Isolation has two halves that fail in opposite ways: point pi somewhere of
 * our own, but carry over enough that the model catalog is not empty — an empty
 * catalog leaves the picker blank and every session failing with "model is not
 * available".
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ensurePiAgentDirIsolated,
  isolatePiAgentDir,
  PI_AGENT_DIR_ENV,
  SEEDED_FILES,
} from "./agent-dir.ts";

const original = process.env[PI_AGENT_DIR_ENV];
afterEach(() => {
  if (original === undefined) delete process.env[PI_AGENT_DIR_ENV];
  else process.env[PI_AGENT_DIR_ENV] = original;
});

const hostDir = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "semla-host-"));
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body, "utf8");
  }
  return dir;
};

const target = () => join(mkdtempSync(join(tmpdir(), "semla-agent-")), "agent");

describe("isolatePiAgentDir", () => {
  it("points pi at the given directory", () => {
    const dir = target();

    isolatePiAgentDir({ dir, hostDir: hostDir({}) });

    // The name pi actually reads — not PI_AGENT_DIR, which is Semla's own.
    expect(process.env[PI_AGENT_DIR_ENV]).toBe(dir);
    expect(existsSync(dir)).toBe(true);
  });

  it("seeds credentials and the catalog on first run", () => {
    const dir = target();
    const host = hostDir({
      "auth.json": '{"openrouter":{}}',
      "models-store.json": '{"models":[]}',
    });

    const { seeded } = isolatePiAgentDir({ dir, hostDir: host });

    expect(seeded.sort()).toEqual([...SEEDED_FILES].sort());
    expect(readFileSync(join(dir, "auth.json"), "utf8")).toBe('{"openrouter":{}}');
  });

  // Copying these across would re-inherit the host's installed packages, which
  // is the double-load that PI_AGENT_DIR exists to prevent.
  it.each(["settings.json", "npm", "skills"])("never carries over %s", (name) => {
    const dir = target();
    const host = hostDir({ "auth.json": "{}", [name]: "{}" });

    isolatePiAgentDir({ dir, hostDir: host });

    expect(existsSync(join(dir, name))).toBe(false);
  });

  it("does not overwrite a seeded file, so the host stops having a say", () => {
    const dir = target();
    const host = hostDir({ "auth.json": '{"host":true}' });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "auth.json"), '{"semla":true}', "utf8");

    const { seeded } = isolatePiAgentDir({ dir, hostDir: host });

    expect(seeded).toEqual([]);
    expect(readFileSync(join(dir, "auth.json"), "utf8")).toBe('{"semla":true}');
  });

  it("works with no host install at all, as in a container", () => {
    const dir = target();

    const { seeded } = isolatePiAgentDir({
      dir,
      hostDir: join(tmpdir(), "semla-absent-host"),
    });

    // Credentials then come from PI_MODEL_API_KEY, which session-service
    // injects with setRuntimeApiKey.
    expect(seeded).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });
});

/**
 * The safety net for a process where instrumentation.ts's register() never
 * ran — observed live: a route reading PI_CODING_AGENT_DIR mid-request found
 * it genuinely unset, well after boot, with no thrown error anywhere to say
 * so. Every call site that reads it (or constructs a ModelRuntime) without
 * going through runtime-config can call this instead of isolatePiAgentDir()
 * directly and not have to trust that ordering.
 */
describe("ensurePiAgentDirIsolated", () => {
  it("sets the env var even if isolatePiAgentDir() was never called in this process", () => {
    delete process.env[PI_AGENT_DIR_ENV];

    ensurePiAgentDirIsolated();

    expect(process.env[PI_AGENT_DIR_ENV]).toBeTruthy();
  });

  it("does not clobber an env var another call already set correctly", () => {
    const dir = target();
    process.env[PI_AGENT_DIR_ENV] = dir;

    ensurePiAgentDirIsolated();

    expect(process.env[PI_AGENT_DIR_ENV]).toBe(dir);
  });

  it("re-isolates if the env var is cleared out from under it", () => {
    ensurePiAgentDirIsolated();
    const first = process.env[PI_AGENT_DIR_ENV];
    expect(first).toBeTruthy();

    // Simulates the exact failure observed live: the var reads back unset
    // mid-process, well after any call that should have set it.
    delete process.env[PI_AGENT_DIR_ENV];

    ensurePiAgentDirIsolated();

    expect(process.env[PI_AGENT_DIR_ENV]).toBe(first);
  });
});
