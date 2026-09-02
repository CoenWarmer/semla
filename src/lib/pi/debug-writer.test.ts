/**
 * The phase markers exist because of a session that took 81 seconds to answer
 * "Hi how's it going?" and left an artifact that could not say why: the first
 * event was the prompt, the next was a persisted entry 78 seconds later. The
 * markers are only worth having if they are actually written, and if the
 * first-token measurement is anchored to the request rather than to whatever
 * delta happens to arrive next.
 */
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let root: string;
let cwdSpy: ReturnType<typeof vi.spyOn>;

/**
 * The writer resolves its output directory from process.cwd() at import time,
 * so the spy and the env have to be in place before the dynamic import.
 */
const load = async (dev = true) => {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", dev ? "development" : "production");
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(root);
  return import("./debug-writer.ts");
};

const events = async (sessionId: string) => {
  const raw = await readFile(
    join(root, ".semla-debug", "sessions", sessionId, "events.jsonl"),
    "utf8",
  );
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "semla-debug-"));
});

afterEach(async () => {
  cwdSpy?.mockRestore();
  vi.unstubAllEnvs();
  await rm(root, { force: true, recursive: true });
});

describe("phase markers", () => {
  it("records each phase with its own duration", async () => {
    const { createSessionDebugWriter } = await load();
    const writer = createSessionDebugWriter("s1");

    writer.onPromptStart("hi", "openrouter/anthropic/claude-sonnet-5", ["read"]);
    writer.onPhase("model-resolved", 12);
    writer.onPhase("extensions-compiled", 439);

    const written = await events("s1");
    expect(written.filter((e) => e.type === "phase")).toEqual([
      expect.objectContaining({ ms: 12, phase: "model-resolved" }),
      expect.objectContaining({ ms: 439, phase: "extensions-compiled" }),
    ]);
  });

  /**
   * The event timestamps are second-resolution, so a reader cannot lay phases
   * on a timeline from `t` alone.
   */
  it("places each phase on the turn's timeline", async () => {
    const { createSessionDebugWriter } = await load();
    const writer = createSessionDebugWriter("s1");

    writer.onPromptStart("hi", "m", []);
    writer.onPhase("model-resolved", 5);

    const [phase] = (await events("s1")).filter((e) => e.type === "phase");
    expect(typeof phase!.sincePromptMs).toBe("number");
    expect(phase!.sincePromptMs as number).toBeGreaterThanOrEqual(0);
  });
});

describe("first-token latency", () => {
  it("measures the first delta against the model request", async () => {
    const { createSessionDebugWriter } = await load();
    const writer = createSessionDebugWriter("s1");

    writer.onPromptStart("hi", "m", []);
    writer.onModelRequestStart();
    writer.onAssistantDelta("Doing");

    const firstToken = (await events("s1")).filter(
      (e) => e.type === "first-token",
    );
    expect(firstToken).toHaveLength(1);
    expect(typeof firstToken[0]!.ms).toBe("number");
  });

  // One per request, not one per delta.
  it("reports it once however many deltas follow", async () => {
    const { createSessionDebugWriter } = await load();
    const writer = createSessionDebugWriter("s1");

    writer.onPromptStart("hi", "m", []);
    writer.onModelRequestStart();
    writer.onAssistantDelta("Doing");
    writer.onAssistantDelta(" well");
    writer.onAssistantDelta(", thanks!");

    expect(
      (await events("s1")).filter((e) => e.type === "first-token"),
    ).toHaveLength(1);
  });

  /**
   * A background report turn streams deltas long after the prompt turn's
   * request completed. Measuring those against it would report a first-token
   * latency of minutes and bury the number this exists to surface.
   */
  it("does not measure a delta with no request outstanding", async () => {
    const { createSessionDebugWriter } = await load();
    const writer = createSessionDebugWriter("s1");

    writer.onPromptStart("hi", "m", []);
    writer.onBgDelivery();
    writer.onAssistantDelta("the background result");

    expect(
      (await events("s1")).filter((e) => e.type === "first-token"),
    ).toEqual([]);
  });

  it("re-arms for the next turn on the same session", async () => {
    const { createSessionDebugWriter } = await load();
    const writer = createSessionDebugWriter("s1");

    writer.onPromptStart("hi", "m", []);
    writer.onModelRequestStart();
    writer.onAssistantDelta("one");
    writer.onPromptStart("again", "m", []);
    writer.onModelRequestStart();
    writer.onAssistantDelta("two");

    expect(
      (await events("s1")).filter((e) => e.type === "first-token"),
    ).toHaveLength(2);
  });

  // A prompt that is answered entirely by a tool call emits no delta.
  it("says nothing when the request produced no assistant text", async () => {
    const { createSessionDebugWriter } = await load();
    const writer = createSessionDebugWriter("s1");

    writer.onPromptStart("hi", "m", []);
    writer.onModelRequestStart();
    writer.onToolStart("bash");

    const written = await events("s1");
    expect(written.filter((e) => e.type === "first-token")).toEqual([]);
    expect(written.some((e) => e.type === "model-request-start")).toBe(true);
  });
});

/**
 * A phase that is declared but never emitted is a hole in the window with a
 * name — it reads as covered and records nothing. Only the turn itself can say
 * whether each one is wired, and the turn needs Supabase and a provider to run,
 * so this is checked against the source.
 */
describe("SessionPhase coverage", () => {
  const read = (file: string) =>
    readFileSync(join(process.cwd(), file), "utf8");

  it("emits every phase it declares, and declares every phase it emits", () => {
    // The union members, off the type declaration itself.
    const union = /export type SessionPhase =([\s\S]*?);\n/.exec(
      read("src/lib/pi/debug-writer.ts"),
    )?.[1];
    const declared = [...(union ?? "").matchAll(/"([a-z-]+)"/g)].map(
      (match) => match[1]!,
    );

    const turn = read("src/lib/pi/session-service.ts");
    const emitted = [...turn.matchAll(/\bphase\("([a-z-]+)"\)/g)].map(
      (match) => match[1]!,
    );

    expect(declared.length).toBeGreaterThan(0);
    expect([...declared].sort()).toEqual([...new Set(emitted)].sort());
  });
});

/**
 * The writer is a development aid; production sessions must not pay for it or
 * write transcripts to disk.
 */
describe("outside development", () => {
  it("writes nothing at all", async () => {
    const { createSessionDebugWriter } = await load(false);
    const writer = createSessionDebugWriter("s1");

    writer.onPromptStart("hi", "m", []);
    writer.onPhase("model-turn", 81_000);
    writer.onModelRequestStart();
    writer.onAssistantDelta("x");

    await expect(events("s1")).rejects.toThrow();
  });
});
