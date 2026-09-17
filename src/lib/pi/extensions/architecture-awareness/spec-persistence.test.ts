/**
 * Handler-level tests, matching the fake-ExtensionAPI convention in
 * read-router.test.ts — a fake `pi.on` capturing handlers, fired directly with
 * a minimal ExtensionContext.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BeforeAgentStartEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readSpecLog, specLogPath } from "./spec-log";
import { SEMLA_ARTIFACT_DIR } from "@/lib/pi/runtime/runtime-config";

const specPersistenceExtension = (await import("./spec-persistence")).default;

type Handler = (event: unknown, ctx: unknown) => unknown;

function makePi() {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on: vi.fn((event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }),
    registerTool: vi.fn(),
  } as unknown as Parameters<typeof specPersistenceExtension>[0];

  return {
    fire: async (event: string, payload: unknown, ctx: unknown) => {
      const list = handlers.get(event) ?? [];
      let last: unknown;
      for (const handler of list) last = await handler(payload, ctx);
      return last;
    },
    pi,
  };
}

function makeCtx(sessionDir: string, sessionId = "session-1"): ExtensionContext {
  return {
    cwd: sessionDir,
    sessionManager: {
      getSessionDir: () => sessionDir,
      getSessionId: () => sessionId,
    },
  } as unknown as ExtensionContext;
}

function startEvent(prompt: string, systemPrompt = "BASE PROMPT"): BeforeAgentStartEvent {
  return {
    prompt,
    systemPrompt,
    systemPromptOptions: { cwd: "/repo" } as never,
    type: "before_agent_start",
  };
}

describe("spec-persistence extension", () => {
  let dir: string;

  afterEach(() => {
    if (dir && existsSync(dir)) rmSync(dir, { force: true, recursive: true });
    // recordMarkerSpec (called from the extension when a turn is a captured
    // spec) writes through the real SEMLA_ARTIFACT_DIR — it takes no `dir`
    // override, the same as every other artifact-capture caller — so the
    // "session-1" fixture id used throughout this file needs its own
    // cleanup, separate from the sessionDir/`dir` above.
    rmSync(join(SEMLA_ARTIFACT_DIR, "sessions", "session-1"), {
      force: true,
      recursive: true,
    });
  });

  it("appends the verbatim user turn and injects the rendered log into the system prompt", async () => {
    dir = mkdtempSync(join(tmpdir(), "spec-persistence-test-"));
    const { fire, pi } = makePi();
    specPersistenceExtension(pi);

    const result = (await fire("before_agent_start", startEvent("keep this constraint"), makeCtx(dir))) as {
      systemPrompt?: string;
    };

    expect(result?.systemPrompt).toContain("BASE PROMPT");
    expect(result?.systemPrompt).toContain("keep this constraint");

    const turns = readSpecLog(dir, "session-1");
    expect(turns).toHaveLength(1);
    expect(turns[0].text).toBe("keep this constraint");
    expect(turns[0].loadBearing).toBe(false);
  });

  it("marks an @spec-prefixed turn as load-bearing and strips the marker from the stored text", async () => {
    dir = mkdtempSync(join(tmpdir(), "spec-persistence-test-"));
    const { fire, pi } = makePi();
    specPersistenceExtension(pi);

    await fire("before_agent_start", startEvent("@spec always use tabs"), makeCtx(dir));

    const turns = readSpecLog(dir, "session-1");
    expect(turns[0]).toMatchObject({ loadBearing: true, text: "always use tabs" });
  });

  it("does not overwrite earlier turns when a later, contradicting one arrives — append-only", async () => {
    dir = mkdtempSync(join(tmpdir(), "spec-persistence-test-"));
    const { fire, pi } = makePi();
    specPersistenceExtension(pi);

    await fire("before_agent_start", startEvent("use tabs"), makeCtx(dir));
    await fire("before_agent_start", startEvent("actually, use spaces"), makeCtx(dir));

    const turns = readSpecLog(dir, "session-1");
    expect(turns.map((t) => t.text)).toEqual(["use tabs", "actually, use spaces"]);
  });

  it("does not append or inject for an empty prompt (programmatic continuation)", async () => {
    dir = mkdtempSync(join(tmpdir(), "spec-persistence-test-"));
    const { fire, pi } = makePi();
    specPersistenceExtension(pi);

    const result = await fire("before_agent_start", startEvent(""), makeCtx(dir));

    expect(result).toBeUndefined();
    expect(existsSync(specLogPath(dir, "session-1"))).toBe(false);
  });

  it("does nothing when specPersistenceEnabled is off in project settings", async () => {
    dir = mkdtempSync(join(tmpdir(), "spec-persistence-test-"));
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(dir, ".semla"), { recursive: true });
    writeFileSync(
      join(dir, ".semla", "architecture-awareness-settings.json"),
      JSON.stringify({ specPersistenceEnabled: false }),
    );

    const { fire, pi } = makePi();
    specPersistenceExtension(pi);

    const result = await fire("before_agent_start", startEvent("should not be persisted"), makeCtx(dir));

    expect(result).toBeUndefined();
    expect(existsSync(specLogPath(dir, "session-1"))).toBe(false);
  });
});
