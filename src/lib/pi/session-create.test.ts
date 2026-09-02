/**
 * Two routes create sessions now — the explicit one, and the prompt route
 * creating the session it is being asked to prompt so that starting one costs a
 * single request. This is the shared implementation, so it is where the rules
 * live: what the row is called, when there is nothing to create, and what
 * happens to the disk record when the insert fails.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/types/database.types";
import {
  createSession,
  readSessionCreateRequest,
  sessionExistsOnDisk,
} from "./session-create.ts";
import { readSessionMeta } from "./session-meta.ts";

/** Synthetic on purpose: never a real session's id. */
const ID = "00000000-0000-4000-8000-00000000dead";
const USER = "00000000-0000-4000-8000-000000000a01";

let dir: string;

/** Records what was inserted, and can be told to fail the way Postgres would. */
const fakeClient = (error?: { code?: string; message: string }) => {
  const inserted: unknown[] = [];
  const client = {
    from: () => ({
      insert: (row: unknown) => {
        inserted.push(row);
        return Promise.resolve({ error: error ?? null });
      },
    }),
  } as unknown as SupabaseClient<Database>;
  return { client, inserted };
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "semla-create-"));
});

afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
  vi.restoreAllMocks();
});

describe("readSessionCreateRequest", () => {
  it("takes the title and project it is given", () => {
    expect(
      readSessionCreateRequest({ id: ID, project: "semla", title: "semla" }),
    ).toEqual({ id: ID, project: "semla", title: "semla" });
  });

  it("falls back to a placeholder title", () => {
    expect(readSessionCreateRequest({}).title).toBe("New Session");
    expect(readSessionCreateRequest({ title: "   " }).title).toBe("New Session");
  });

  it("has no project when none was chosen", () => {
    expect(readSessionCreateRequest({}).project).toBeNull();
    expect(readSessionCreateRequest({ project: "  " }).project).toBeNull();
  });

  // Validation itself is session-id.ts's; this is the wiring.
  it("drops an id it cannot use, leaving one to be minted", () => {
    expect(readSessionCreateRequest({ id: "../etc" }).id).toBeNull();
  });

  it("survives a body that is not an object", () => {
    expect(readSessionCreateRequest(null).title).toBe("New Session");
  });
});

describe("createSession", () => {
  it("inserts the row under the id it was given", async () => {
    const { client, inserted } = fakeClient();

    const result = await createSession({
      client,
      dir,
      id: ID,
      project: null,
      title: "New Session",
      userId: USER,
    });

    expect(result).toEqual({ id: ID, kind: "created" });
    expect(inserted).toEqual([
      { id: ID, title: "New Session", user_id: USER },
    ]);
  });

  /**
   * Naming a session needs no database. Taking the id back out of the insert is
   * what made the disk record — and the response — wait on it.
   */
  it("mints an id when the caller has no preference", async () => {
    const { client, inserted } = fakeClient();

    const result = await createSession({
      client,
      dir,
      id: null,
      project: null,
      title: "New Session",
      userId: USER,
    });

    expect(result.kind).toBe("created");
    const minted = (result as { id: string }).id;
    expect(minted).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(inserted).toEqual([
      { id: minted, title: "New Session", user_id: USER },
    ]);
  });

  it("records the session on disk, which is what every reader consults", async () => {
    const { client } = fakeClient();

    await createSession({
      client,
      dir,
      id: ID,
      project: null,
      title: "A session",
      userId: USER,
    });

    expect(readSessionMeta(ID, dir)).toMatchObject({
      id: ID,
      title: "A session",
      userId: USER,
    });
  });

  it("anchors the session to the project it was opened from", async () => {
    const { client } = fakeClient();

    await createSession({
      client,
      dir,
      id: ID,
      project: "semla",
      title: "semla",
      userId: USER,
    });

    expect(readSessionMeta(ID, dir)?.projects).toEqual([
      expect.objectContaining({
        isPrimary: true,
        origin: "explicit",
        path: "semla",
      }),
    ]);
  });

  /**
   * The id can come from a client, so a collision is refused against the
   * authoritative store. Left to the table's primary key it would be caught
   * only after the disk record of the session that owns the id had been
   * overwritten.
   */
  it("refuses an id this machine already has, without inserting", async () => {
    const { client, inserted } = fakeClient();
    await createSession({
      client,
      dir,
      id: ID,
      project: null,
      title: "First",
      userId: USER,
    });

    const again = await createSession({
      client,
      dir,
      id: ID,
      project: null,
      title: "Second",
      userId: USER,
    });

    expect(again).toEqual({ id: ID, kind: "exists" });
    expect(inserted).toHaveLength(1);
    expect(readSessionMeta(ID, dir)?.title).toBe("First");
  });

  it("refuses an id that has a transcript but no record", async () => {
    await writeFile(join(dir, `${ID}.jsonl`), '{"type":"session"}\n', "utf8");
    const { client, inserted } = fakeClient();

    const result = await createSession({
      client,
      dir,
      id: ID,
      project: null,
      title: "New Session",
      userId: USER,
    });

    expect(result).toEqual({ id: ID, kind: "exists" });
    expect(inserted).toEqual([]);
  });

  /**
   * Two requests raced for the same new session. The row exists, which is all
   * either caller wanted.
   */
  it("treats a unique violation as already created", async () => {
    const { client } = fakeClient({ code: "23505", message: "duplicate key" });

    expect(
      await createSession({
        client,
        dir,
        id: ID,
        project: null,
        title: "New Session",
        userId: USER,
      }),
    ).toEqual({ id: ID, kind: "exists" });
  });

  /**
   * A session on disk with no row is broken rather than degraded — the first
   * turn cannot write `pi_sessions` without it — so a failed insert must not
   * leave a record behind that looks like a usable session.
   */
  it("writes no disk record when the insert fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = fakeClient({ message: "522" });

    const result = await createSession({
      client,
      dir,
      id: ID,
      project: null,
      title: "New Session",
      userId: USER,
    });

    expect(result).toEqual({ kind: "failed", message: "522" });
    expect(readSessionMeta(ID, dir)).toBeNull();
    expect(sessionExistsOnDisk(ID, dir)).toBe(false);
  });
});

/**
 * This is where the id becomes a filename — `<session dir>/<id>.json` — and one
 * caller takes it from a route parameter. The check lives here rather than in
 * that route, so it cannot be lost by a caller that forgets.
 */
describe("an id that is not a uuid", () => {
  it.each([
    "../../escape",
    "00000000-0000-4000-8000-00000000dead/../other",
    "not-a-uuid",
    "",
  ])("is refused rather than written: %s", async (bad) => {
    const { client, inserted } = fakeClient();

    const result = await createSession({
      client,
      dir,
      id: bad,
      project: null,
      title: "New Session",
      userId: USER,
    });

    expect(result).toEqual({
      kind: "failed",
      message: "A session id must be a uuid.",
    });
    expect(inserted).toEqual([]);
  });

  it("leaves nothing behind in the session directory", async () => {
    const { client } = fakeClient();

    await createSession({
      client,
      dir,
      id: "../escaped",
      project: null,
      title: "New Session",
      userId: USER,
    });

    await expect(readFile(join(dir, "../escaped.json"), "utf8")).rejects.toThrow();
  });
});

describe("sessionExistsOnDisk", () => {
  it("is false for a session this machine has never seen", () => {
    expect(sessionExistsOnDisk(ID, dir)).toBe(false);
  });

  it("is true once the record is written", async () => {
    const { client } = fakeClient();
    await createSession({
      client,
      dir,
      id: ID,
      project: null,
      title: "New Session",
      userId: USER,
    });

    expect(sessionExistsOnDisk(ID, dir)).toBe(true);
  });

  // An empty transcript is not a session; hasTranscript requires a non-empty file.
  it("is false for an empty transcript file", async () => {
    await writeFile(join(dir, `${ID}.jsonl`), "", "utf8");

    expect(sessionExistsOnDisk(ID, dir)).toBe(false);
  });
});

describe("the temp directory is really being used", () => {
  it("writes the record into the directory it was given", async () => {
    const { client } = fakeClient();
    await createSession({
      client,
      dir,
      id: ID,
      project: null,
      title: "New Session",
      userId: USER,
    });

    // Guards against a future default swallowing `dir` and writing into the
    // real session directory, which a probe in this repo has already done once.
    await expect(readFile(join(dir, `${ID}.json`), "utf8")).resolves.toContain(
      ID,
    );
  });
});
