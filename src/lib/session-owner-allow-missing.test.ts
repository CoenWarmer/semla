/**
 * A session is created by its own first prompt now, so its page mounts and
 * starts polling before anything exists. A captured flow had nine 404s before
 * the turn began, and one of them — /api/tools — left the prompt bar reporting
 * no extension tools at all.
 *
 * The routes those polls hit already answered emptily for a session with
 * nothing in it (`/status` even says "or be mid-creation"), but the ownership
 * check refused first, so that handling was unreachable.
 *
 * Two things matter. Reads answer. And anything that *acts* on a session still
 * refuses, because acting on one that does not exist is a bug rather than an
 * empty answer — a mistake this test caught while it was being written, with
 * `allowMissing` applied to the handler that writes a context inspection.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/types/database.types";

const MISSING = "00000000-0000-4000-8000-00000000dead";

/**
 * Passed so the helper does not reach for `createClient()`, which calls Next's
 * `cookies()` and needs a request scope. Bound to loopback there is nobody to
 * authenticate, so it is never actually used.
 */
const stubClient = {} as unknown as SupabaseClient<Database>;

const load = async () => {
  vi.resetModules();
  return import("./session-auth.ts");
};

const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

/** Every route file under src/app/api. */
const routeFiles = (dir = "src/app/api"): string[] =>
  readdirSync(join(process.cwd(), dir), { withFileTypes: true }).flatMap(
    (entry) => {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return routeFiles(path);
      return entry.name === "route.ts" ? [path] : [];
    },
  );

/**
 * Which HTTP method each `allowMissing: true` sits under, by walking the file
 * and remembering the last handler declared. Crude, and enough: a route file
 * declares its handlers at the top level in source order.
 */
const tolerantHandlers = (file: string): string[] => {
  const found: string[] = [];
  let handler = "<module>";

  for (const line of read(file).split("\n")) {
    const declaration = /export async function (GET|POST|PATCH|PUT|DELETE)/.exec(
      line,
    );
    if (declaration) handler = declaration[1]!;
    if (/allowMissing:\s*true/.test(line)) found.push(handler);
  }

  return found;
};

describe("requireSessionOwner on a session with no record", () => {
  it("refuses by default", async () => {
    const { requireSessionOwner } = await load();

    await expect(
      requireSessionOwner(MISSING, stubClient),
    ).rejects.toBeInstanceOf(Response);
  });

  it("reports 404 rather than an error", async () => {
    const { requireSessionOwner } = await load();

    const refusal = (await requireSessionOwner(MISSING, stubClient).catch(
      (error: unknown) => error,
    )) as Response;

    expect(refusal.status).toBe(404);
  });

  it("answers when the caller allows a missing session", async () => {
    const { requireSessionOwner } = await load();

    const result = await requireSessionOwner(MISSING, stubClient, {
      allowMissing: true,
    });

    expect(result.session).toEqual({ id: MISSING });
    expect(result.user.id).toBeTruthy();
  });
});

/**
 * The dangerous direction. `allowMissing` on a handler that prompts, stops or
 * attaches would let a caller act on a session that does not exist. The prompt
 * route creates one deliberately and *then* checks ownership properly, which is
 * not the same thing and is why it does not appear here.
 */
describe("which handlers may allow a missing session", () => {
  const tolerant = routeFiles().flatMap((file) =>
    tolerantHandlers(file).map((handler) => `${handler} ${file}`),
  );

  it("is exactly the read-only polls a pending session makes", () => {
    expect([...tolerant].sort()).toEqual([
      "GET src/app/api/sessions/[id]/context-check/route.ts",
      // The trace the panel loads on mount, for the same reason as /status:
      // a session created by its own first prompt is read before it exists.
      "GET src/app/api/sessions/[id]/spans/route.ts",
      "GET src/app/api/sessions/[id]/status/route.ts",
      "GET src/app/api/tools/route.ts",
    ]);
  });

  it("never sits under a method that changes anything", () => {
    for (const entry of tolerant) {
      expect(entry.startsWith("GET ")).toBe(true);
    }
  });
});
