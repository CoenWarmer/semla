/**
 * These writes throw, and most callers fire them without waiting. With no
 * catch, a transient Supabase outage becomes an unhandled rejection — which
 * Node terminates the process for by default, so a database blip could take the
 * server down mid-turn. `detach` absorbs and logs them; see session-log.test.ts
 * for the absorbing itself.
 *
 * What a unit test cannot see is a *new* call site added without it, so that
 * part stays a source scan. It reads every module that makes one of these
 * writes rather than a single file: the turn's writes were split across three
 * when runPiPrompt was broken up, and a guard pinned to one file would have
 * silently stopped covering the other two.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/** Writes that reject, and must therefore never be fired as a bare `void`. */
const THROWING_WRITES = [
  "persistWorkflowSnapshot",
  "persistBackgroundWorkflowStart",
  "setSessionRunning",
  "updateSessionTitle",
  "finalizeBackgroundRun",
] as const;

/**
 * Every module that calls one. Kept explicit rather than globbed so that adding
 * a caller is a deliberate edit here, with this comment in front of it.
 */
const CALLERS = [
  "src/app/api/sessions/[id]/stream/route.ts",
  "src/app/api/sessions/[id]/workflows/route.ts",
  "src/lib/pi/background-continuation.ts",
  "src/lib/pi/session-event-router.ts",
  "src/lib/pi/session-service.ts",
] as const;

const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

/** Every non-test TypeScript source file under `dir`, repo-relative. */
const sourceFiles = (dir: string): string[] =>
  readdirSync(join(process.cwd(), dir), { withFileTypes: true }).flatMap(
    (entry) => {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return sourceFiles(path);
      if (!/\.tsx?$/.test(entry.name) || entry.name.includes(".test.")) {
        return [];
      }
      return [path];
    },
  );

describe("fire-and-forget persistence calls", () => {
  it.each(CALLERS)("%s fires no throwing write as a bare void", (file) => {
    const source = read(file);

    for (const write of THROWING_WRITES) {
      expect(
        new RegExp(String.raw`void\s+${write}\s*\(`).test(source),
        `${file} calls \`void ${write}(...)\`. Wrap it in detach() so a failed ` +
          "write is logged instead of becoming an unhandled rejection.",
      ).toBe(false);
    }
  });

  /**
   * The list above is only worth anything if it is complete, so check it the
   * other way round too: no module outside it may call one of these.
   */
  it("names every module that makes one of these writes", () => {
    const unlisted = sourceFiles("src").filter(
      (path) =>
        !(CALLERS as readonly string[]).includes(path) &&
        // Where they are defined, so its own calls are the definitions.
        path !== "src/lib/pi/session-persistence.ts" &&
        THROWING_WRITES.some((write) =>
          new RegExp(String.raw`\b${write}\s*\(`).test(read(path)),
        ),
    );

    expect(
      unlisted,
      "These modules call a throwing write but are not in CALLERS, so the " +
        "bare-void guard above never reads them. Add them.",
    ).toEqual([]);
  });
});

/**
 * finalizeBackgroundRun takes (sessionId, runId, status) and every parameter is
 * a string, so passing the run id where the session id belongs compiles
 * cleanly — and writes the run into an index named after itself, where the
 * session's panel will never look. tsc cannot see it; this can.
 */
describe("finalizeBackgroundRun call sites", () => {
  const callers = CALLERS.filter((file) =>
    read(file).includes("finalizeBackgroundRun("),
  );

  it("has call sites to check", () => {
    expect(callers.length).toBeGreaterThan(0);
  });

  it.each(callers)("%s passes a session id first", (file) => {
    const calls = [...read(file).matchAll(/finalizeBackgroundRun\(([^)]*)\)/g)]
      .map((match) => match[1]!.trim())
      .filter((args) => args.length > 0);

    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) {
      const first = args.split(",")[0]!.trim();
      expect(
        /^(semlaSessionId|id)$/.test(first),
        `finalizeBackgroundRun(${args}) starts with "${first}", which is not a ` +
          "session id. The run would be indexed under its own id.",
      ).toBe(true);
    }
  });
});
