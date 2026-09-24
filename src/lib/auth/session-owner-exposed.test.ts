/**
 * Exposed, a session with no row for the caller is either one that has not
 * been mirrored yet or one that belongs to somebody else — the row lookup is
 * filtered by `user_id`, so both look the same from Postgres. The tolerant
 * reads (`/messages`, `/file-access`, …) load their answer from disk by id, so
 * treating the second like the first handed one user another's transcript.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { SessionMeta } from "@/lib/pi/session/session-meta";
import type { Database } from "@/types/database.types";

const CALLER = "user-caller";
const SESSION = "00000000-0000-4000-8000-0000000000aa";

const clientWithoutRow = () =>
  ({
    auth: { getUser: async () => ({ data: { user: { id: CALLER } }, error: null }) },
    from: () => {
      const query = {
        eq: () => query,
        maybeSingle: async () => ({ data: null, error: null }),
        select: () => query,
      };
      return query;
    },
  }) as unknown as SupabaseClient<Database>;

const load = async (disk: { meta: Partial<SessionMeta> | null; transcript: boolean }) => {
  vi.resetModules();
  vi.stubEnv("SEMLA_BIND_HOST", "0.0.0.0");
  vi.doMock("@/lib/pi/session/session-meta", () => ({
    hasTranscript: () => disk.transcript,
    readSessionMeta: () => disk.meta,
  }));
  return import("./session-auth.ts");
};

const statusOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => 200,
    (error: unknown) => (error instanceof Response ? error.status : 500),
  );

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("@/lib/pi/session/session-meta");
  vi.resetModules();
});

describe("requireSessionOwner, exposed, allowMissing", () => {
  const ask = async (disk: Parameters<typeof load>[0]) => {
    const { requireSessionOwner } = await load(disk);
    return statusOf(
      requireSessionOwner(SESSION, clientWithoutRow(), { allowMissing: true }),
    );
  };

  it("answers for a session that does not exist anywhere yet", async () => {
    expect(await ask({ meta: null, transcript: false })).toBe(200);
  });

  it("answers for the caller's own session before its row is mirrored", async () => {
    expect(await ask({ meta: { userId: CALLER }, transcript: false })).toBe(200);
  });

  it("refuses another user's session", async () => {
    expect(await ask({ meta: { userId: "someone-else" }, transcript: true })).toBe(404);
  });

  it("refuses a transcript on disk with no owner recorded", async () => {
    expect(await ask({ meta: null, transcript: true })).toBe(404);
  });
});
