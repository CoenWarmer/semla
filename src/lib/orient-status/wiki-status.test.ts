/**
 * Phase 2's status file: the four reads, and the staleness rule that a dirty
 * capture can never be confirmed fresh.
 *
 * The dirty case is the one worth stating plainly. A wiki capture taken against
 * a tree with uncommitted changes describes a state no commit sha names, so an
 * unchanged HEAD does not make it current — the working tree it read may have
 * been committed, reverted or edited further since, and nothing recorded can
 * tell those apart.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { orientStatusPaths } from "./paths";
import { writeVerificationStatus } from "./verification-status";
import { isWikiStale, readWikiStatus, writeWikiStatus } from "./wiki-status";

let root: string;
let orientHome: string;
let previousHome: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "orient-wiki-root-"));
  orientHome = mkdtempSync(join(tmpdir(), "orient-wiki-home-"));
  previousHome = process.env.SEMLA_ORIENT_HOME;
  process.env.SEMLA_ORIENT_HOME = orientHome;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.SEMLA_ORIENT_HOME;
  else process.env.SEMLA_ORIENT_HOME = previousHome;
  rmSync(root, { force: true, recursive: true });
  rmSync(orientHome, { force: true, recursive: true });
});

describe("readWikiStatus", () => {
  it("reads a missing file as never-run, not as an error", async () => {
    expect((await readWikiStatus(root)).kind).toBe("never-run");
  });

  it("round-trips a written status", async () => {
    await writeWikiStatus({
      capturedAt: "2026-01-01T00:00:00.000Z",
      commitSha: "abc123",
      dirty: false,
      root,
    });

    const read = await readWikiStatus(root);
    expect(read.kind).toBe("ok");
    if (read.kind !== "ok") return;
    expect(read.status.commitSha).toBe("abc123");
    expect(read.status.dirty).toBe(false);
    expect(read.status.root).toBe(resolve(root));
  });

  it("reports a corrupt file rather than throwing", async () => {
    const paths = orientStatusPaths(root);
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.wiki, "{ not json", "utf8");

    const read = await readWikiStatus(root);
    expect(read.kind).toBe("unreadable");
    if (read.kind !== "unreadable") return;
    expect(read.reason).toContain("not valid JSON");
  });

  it("accepts a missing commitSha as null but rejects a wrong type", async () => {
    const paths = orientStatusPaths(root);
    mkdirSync(paths.dir, { recursive: true });

    writeFileSync(
      paths.wiki,
      JSON.stringify({ capturedAt: "2026-01-01T00:00:00.000Z", root: resolve(root) }),
      "utf8",
    );
    const absent = await readWikiStatus(root);
    expect(absent.kind).toBe("ok");
    if (absent.kind === "ok") expect(absent.status.commitSha).toBeNull();

    // A wrong type means some other writer produced this file, so its other
    // fields cannot be trusted either.
    writeFileSync(
      paths.wiki,
      JSON.stringify({
        capturedAt: "2026-01-01T00:00:00.000Z",
        commitSha: 42,
        root: resolve(root),
      }),
      "utf8",
    );
    expect((await readWikiStatus(root)).kind).toBe("unreadable");
  });

  it("identifies a record describing a different project as orphaned", async () => {
    const paths = orientStatusPaths(root);
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(
      paths.wiki,
      JSON.stringify({
        capturedAt: "2026-01-01T00:00:00.000Z",
        commitSha: "abc",
        dirty: false,
        root: "/somewhere/else",
      }),
      "utf8",
    );

    const read = await readWikiStatus(root);
    expect(read.kind).toBe("orphaned");
    if (read.kind !== "orphaned") return;
    expect(read.recordedRoot).toBe("/somewhere/else");
  });
});

describe("isWikiStale", () => {
  const ok = (commitSha: string | null, dirty: boolean | null) =>
    ({
      kind: "ok",
      path: "/x",
      status: { capturedAt: "2026-01-01T00:00:00.000Z", commitSha, dirty, root: "/r" },
    }) as const;

  it("is current when the sha matches and the capture was clean", () => {
    expect(isWikiStale(ok("abc", false), { commitSha: "abc" })).toEqual({
      reason: null,
      stale: false,
    });
  });

  it("is stale when HEAD has moved", () => {
    expect(isWikiStale(ok("abc", false), { commitSha: "def" })).toEqual({
      reason: "commit-moved",
      stale: true,
    });
  });

  it("is stale on a matching sha when the capture was dirty", () => {
    // The point of recording `dirty` at all: an unchanged HEAD does not make a
    // capture of uncommitted work current.
    expect(isWikiStale(ok("abc", true), { commitSha: "abc" })).toEqual({
      reason: "captured-dirty",
      stale: true,
    });
  });

  it("distinguishes 'not a git repo' from 'out of date'", () => {
    expect(isWikiStale(ok(null, false), { commitSha: "abc" })).toEqual({
      reason: "no-commit-sha",
      stale: true,
    });
    expect(isWikiStale(ok("abc", false), { commitSha: null })).toEqual({
      reason: "no-commit-sha",
      stale: true,
    });
  });

  it("treats never-run, unreadable and orphaned as stale with their own reasons", () => {
    expect(isWikiStale({ kind: "never-run", path: "/x" }, { commitSha: "a" }).reason).toBe(
      "never-run",
    );
    expect(
      isWikiStale({ kind: "unreadable", path: "/x", reason: "bad" }, { commitSha: "a" })
        .reason,
    ).toBe("unreadable");
    expect(
      isWikiStale(
        { expectedRoot: "/b", kind: "orphaned", path: "/x", recordedRoot: "/a" },
        { commitSha: "a" },
      ).reason,
    ).toBe("orphaned");
  });
});

describe("phase isolation", () => {
  /**
   * Structural rather than a race to test: one file per phase means no code
   * path reads, merges or rewrites the other's file. Asserted in both
   * directions, since the verification test only covers one.
   */
  it("writing wiki status leaves the verification file untouched", async () => {
    await writeVerificationStatus({
      capturedAt: "2026-01-01T00:00:00.000Z",
      inputsDigest: "digest",
      root,
      signals: [],
    });

    await writeWikiStatus({
      capturedAt: "2026-02-02T00:00:00.000Z",
      commitSha: "abc",
      dirty: false,
      root,
    });

    const paths = orientStatusPaths(root);
    const verification = JSON.parse(readFileSync(paths.verification, "utf8")) as {
      inputsDigest: string;
    };
    expect(verification.inputsDigest).toBe("digest");
  });
});
