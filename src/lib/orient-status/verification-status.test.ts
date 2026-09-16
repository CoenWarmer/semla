/**
 * Persistence: the three non-ok reads that must not throw, and the key
 * derivation that must not drift.
 *
 * The orphan case is the one worth stating plainly. A status file carries the
 * absolute root it describes precisely so that a change to code-index's
 * `projectKey` shows up as an identifiable orphan rather than as orient
 * silently reporting never-run for a repo it oriented yesterday.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { projectKey } from "@/lib/code-index/index-paths";
import { SEMLA_STATE_DIR } from "@/lib/stores/user-settings-store";
import type { VerificationSignal } from "@/lib/verification-signals/types";

import { orientStatusDir, orientStatusHomeDir, orientStatusPaths } from "./paths";
import {
  isVerificationStale,
  readVerificationStatus,
  writeVerificationStatus,
} from "./verification-status";

let root: string;
let orientHome: string;
let previousHome: string | undefined;
let previousStateDir: string | undefined;

const signals: VerificationSignal[] = [
  { category: "unit-test", evidence: 'package.json scripts.test = "vitest run"', state: "available" },
];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "orient-root-"));
  orientHome = mkdtempSync(join(tmpdir(), "orient-home-"));
  previousHome = process.env.SEMLA_ORIENT_HOME;
  previousStateDir = process.env.SEMLA_STATE_DIR;
  process.env.SEMLA_ORIENT_HOME = orientHome;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.SEMLA_ORIENT_HOME;
  else process.env.SEMLA_ORIENT_HOME = previousHome;
  if (previousStateDir === undefined) delete process.env.SEMLA_STATE_DIR;
  else process.env.SEMLA_STATE_DIR = previousStateDir;
  rmSync(root, { force: true, recursive: true });
  rmSync(orientHome, { force: true, recursive: true });
});

describe("orientStatusDir", () => {
  it("is keyed by code-index's projectKey", () => {
    // Pinned so a change to that derivation fails here instead of silently
    // orphaning every status directory on disk.
    expect(orientStatusDir(root)).toBe(join(orientHome, projectKey(root)));
  });

  it("honours SEMLA_ORIENT_HOME per call, not at import", () => {
    process.env.SEMLA_ORIENT_HOME = join(orientHome, "elsewhere");
    expect(orientStatusHomeDir()).toBe(join(orientHome, "elsewhere"));
  });

  it("defaults under Semla's own state directory, not the home directory", () => {
    // The first implementation followed indexHomeDir() to ~/.semla/orient,
    // putting per-project state in the user's home for no reason this module
    // needs. Pinned so it cannot drift back: orient status is Semla's own
    // state and belongs beside review marks and run records.
    delete process.env.SEMLA_ORIENT_HOME;
    expect(orientStatusHomeDir()).toBe(join(SEMLA_STATE_DIR, "orient"));
    expect(orientStatusHomeDir().startsWith(join(homedir(), ".semla", "orient"))).toBe(
      false,
    );
  });

  it("moves with SEMLA_STATE_DIR so nothing is left behind when state relocates", async () => {
    delete process.env.SEMLA_ORIENT_HOME;
    process.env.SEMLA_STATE_DIR = join(orientHome, "relocated");
    // Re-imported because SEMLA_STATE_DIR is a module constant, which is the
    // one thing here that is read at import rather than per call.
    vi.resetModules();
    const paths = await import("./paths");
    expect(paths.orientStatusHomeDir()).toBe(
      join(orientHome, "relocated", "orient"),
    );
  });

  it("keeps one file per phase", () => {
    const paths = orientStatusPaths(root);
    expect(paths.verification).not.toBe(paths.wiki);
    expect(paths.verification.startsWith(paths.dir)).toBe(true);
  });
});

describe("readVerificationStatus", () => {
  it("reads a missing file as never-run, not as an error", async () => {
    const read = await readVerificationStatus(root);
    expect(read.kind).toBe("never-run");
  });

  it("round-trips a written status", async () => {
    await writeVerificationStatus({
      capturedAt: "2026-01-01T00:00:00.000Z",
      inputsDigest: "abc",
      root,
      signals,
    });

    const read = await readVerificationStatus(root);
    expect(read.kind).toBe("ok");
    if (read.kind !== "ok") return;
    expect(read.status.inputsDigest).toBe("abc");
    expect(read.status.signals).toEqual(signals);
    expect(read.status.root).toBe(resolve(root));
  });

  it("reports a corrupt file rather than throwing", async () => {
    const paths = orientStatusPaths(root);
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.verification, "{ not json", "utf8");

    const read = await readVerificationStatus(root);
    expect(read.kind).toBe("unreadable");
    if (read.kind !== "unreadable") return;
    expect(read.reason).toContain("not valid JSON");
  });

  it("reports a well-formed file of the wrong shape as unreadable", async () => {
    const paths = orientStatusPaths(root);
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.verification, JSON.stringify({ hello: "world" }), "utf8");

    const read = await readVerificationStatus(root);
    expect(read.kind).toBe("unreadable");
  });

  it("identifies a status file describing a different project as orphaned", async () => {
    const paths = orientStatusPaths(root);
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(
      paths.verification,
      JSON.stringify({
        capturedAt: "2026-01-01T00:00:00.000Z",
        inputsDigest: "abc",
        root: "/somewhere/else",
        signals: [],
      }),
      "utf8",
    );

    const read = await readVerificationStatus(root);
    expect(read.kind).toBe("orphaned");
    if (read.kind !== "orphaned") return;
    expect(read.recordedRoot).toBe("/somewhere/else");
    expect(read.expectedRoot).toBe(resolve(root));
  });
});

describe("isVerificationStale", () => {
  it("is not stale when the recorded digest matches", async () => {
    await writeVerificationStatus({
      capturedAt: "2026-01-01T00:00:00.000Z",
      inputsDigest: "abc",
      root,
      signals,
    });

    expect(isVerificationStale(await readVerificationStatus(root), "abc")).toBe(false);
  });

  it("is stale when the digest has moved", async () => {
    await writeVerificationStatus({
      capturedAt: "2026-01-01T00:00:00.000Z",
      inputsDigest: "abc",
      root,
      signals,
    });

    expect(isVerificationStale(await readVerificationStatus(root), "def")).toBe(true);
  });

  it("treats never-run and unreadable as stale", async () => {
    expect(isVerificationStale({ kind: "never-run", path: "/x" }, "abc")).toBe(true);
    expect(
      isVerificationStale({ kind: "unreadable", path: "/x", reason: "bad" }, "abc"),
    ).toBe(true);
  });
});

describe("phase isolation", () => {
  /**
   * With one file per phase this is structural rather than a race to test:
   * writing verification.json cannot touch wiki.json because no code path
   * reads, merges or rewrites it. Asserted as such.
   */
  it("writing verification status leaves the wiki file untouched", async () => {
    const paths = orientStatusPaths(root);
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.wiki, JSON.stringify({ sentinel: true }), "utf8");

    await writeVerificationStatus({
      capturedAt: "2026-01-01T00:00:00.000Z",
      inputsDigest: "abc",
      root,
      signals,
    });

    const { readFileSync } = await import("node:fs");
    expect(JSON.parse(readFileSync(paths.wiki, "utf8"))).toEqual({ sentinel: true });
  });
});
