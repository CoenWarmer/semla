/**
 * When Supabase's origin is unreachable, PostgREST returns a Cloudflare error
 * page, so error.message is kilobytes of HTML. Interpolated into an Error it
 * buries the one useful fact — the database was unreachable — and, on a
 * snapshot written many times a second, floods the log with markup.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { describeDbError } from "./session-persistence.ts";

const CLOUDFLARE_522 = `<!DOCTYPE html>
<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->
<head>
<title>supabase.co | 522: Connection timed out</title>
<meta charset="UTF-8" />
</head>
<body><div id="cf-wrapper">${"x".repeat(4000)}</div></body>
</html>`;

describe("describeDbError", () => {
  it("reduces an error page to the reason it carries", () => {
    const described = describeDbError(CLOUDFLARE_522);

    expect(described).toBe("upstream returned an error page: supabase.co | 522: Connection timed out");
    expect(described).not.toContain("<");
  });

  it("still says something useful for an untitled error page", () => {
    expect(describeDbError("<html><body>nope</body></html>")).toBe(
      "upstream returned an error page",
    );
  });

  // Real PostgREST errors are short and are the whole point of the log line.
  it.each([
    'duplicate key value violates unique constraint "workflow_runs_run_id_key"',
    'insert or update on table "workflow_runs" violates foreign key constraint',
  ])("passes a database error through unchanged: %s", (message) => {
    expect(describeDbError(message)).toBe(message);
  });

  it("caps a long non-HTML message rather than dropping it", () => {
    const described = describeDbError("e".repeat(900));

    expect(described).toHaveLength(301);
    expect(described.endsWith("…")).toBe(true);
  });
});

/**
 * These writes throw, and every caller fires them without waiting. With no
 * catch, a transient Supabase outage becomes an unhandled rejection — which
 * Node terminates the process for by default, so a database blip could take the
 * server down mid-turn. `detach` absorbs and logs them; this stops the next
 * fire-and-forget call from being added without it.
 */
describe("fire-and-forget persistence calls", () => {
  const source = readFileSync(
    join(process.cwd(), "src/lib/pi/session-service.ts"),
    "utf8",
  );

  const THROWING_WRITES = [
    "persistWorkflowSnapshot",
    "persistBackgroundWorkflowStart",
    "setSessionRunning",
    "updateSessionTitle",
    "finalizeBackgroundRun",
  ];

  it.each(THROWING_WRITES)("never calls %s as a bare void", (fn) => {
    const bare = new RegExp(String.raw`void\s+${fn}\s*\(`);

    expect(
      bare.test(source),
      `${fn} is called as \`void ${fn}(...)\`. Wrap it in detach() so a failed ` +
        "write is logged instead of becoming an unhandled rejection.",
    ).toBe(false);
  });

  it("routes them through detach instead", () => {
    expect(source).toContain("const detach = (");
    // One per call site; the count is not the point, the absence of bare voids is.
    expect(source.split("detach(semlaSessionId").length - 1).toBeGreaterThan(5);
  });
});

/**
 * finalizeBackgroundRun takes (sessionId, runId, status) and every parameter is
 * a string, so passing the run id where the session id belongs compiles
 * cleanly — and writes the run into an index named after itself, where the
 * session's panel will never look. tsc cannot see it; this can.
 */
describe("finalizeBackgroundRun call sites", () => {
  const callers = [
    "src/lib/pi/session-service.ts",
    "src/app/api/sessions/[id]/workflows/route.ts",
  ];

  it.each(callers)("%s passes a session id first", (file) => {
    const source = readFileSync(join(process.cwd(), file), "utf8");
    const calls = [...source.matchAll(/finalizeBackgroundRun\(([^)]*)\)/g)]
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
