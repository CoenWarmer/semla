/**
 * The one staleness comparison both the tool and the prompt nudge read from.
 *
 * Two properties matter more than the individual cases. It must never throw —
 * it runs while a prompt is being assembled, and a staleness check that can
 * fail a turn is worse than none. And it must say *why* a phase is stale, since
 * "never indexed", "HEAD moved" and "a config file changed" call for three
 * different actions.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { collectOrientStaleness, describeStalePhases } from "./staleness";
import { writeVerificationStatus } from "./verification-status";
import { writeWikiStatus } from "./wiki-status";

// The code index is the one phase whose data lives elsewhere (head.json), so
// it is stubbed rather than fabricated on disk — see index-status.ts on why
// there is no orient file for it to write.
vi.mock("@/lib/code-index/store/local", () => ({
  createLocalVectorStore: () => ({ head: async () => headValue }),
}));
vi.mock("@/lib/code-index/index-runs", () => ({
  getIndexRun: () => null,
}));

let headValue: { chunks: number; merkleRoot: string; model: string; updated: string } | null =
  null;

let root: string;
let orientHome: string;
let indexHome: string;
let previous: { orient?: string; index?: string } = {};

function gitInit(path: string) {
  const run = (args: string[]) =>
    execFileSync("git", args, {
      cwd: path,
      env: {
        ...process.env,
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_AUTHOR_NAME: "T",
        GIT_COMMITTER_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "T",
      },
      stdio: "ignore",
    });
  run(["init", "-q"]);
  writeFileSync(join(path, "README.md"), "hello\n", "utf8");
  run(["add", "."]);
  run(["commit", "-qm", "initial"]);
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: path, encoding: "utf8" }).trim();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "orient-stale-root-"));
  orientHome = mkdtempSync(join(tmpdir(), "orient-stale-home-"));
  indexHome = mkdtempSync(join(tmpdir(), "orient-stale-index-"));
  previous = { index: process.env.SEMLA_INDEX_HOME, orient: process.env.SEMLA_ORIENT_HOME };
  process.env.SEMLA_ORIENT_HOME = orientHome;
  process.env.SEMLA_INDEX_HOME = indexHome;
  headValue = null;
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ scripts: { test: "vitest run" } }),
    "utf8",
  );
});

afterEach(() => {
  if (previous.orient === undefined) delete process.env.SEMLA_ORIENT_HOME;
  else process.env.SEMLA_ORIENT_HOME = previous.orient;
  if (previous.index === undefined) delete process.env.SEMLA_INDEX_HOME;
  else process.env.SEMLA_INDEX_HOME = previous.index;
  rmSync(root, { force: true, recursive: true });
  rmSync(orientHome, { force: true, recursive: true });
  rmSync(indexHome, { force: true, recursive: true });
});

describe("collectOrientStaleness", () => {
  it("reports all three phases as unrun on a fresh project", async () => {
    const report = await collectOrientStaleness({ root });

    expect(report.index.stale).toBe("never-indexed");
    expect(report.wiki.staleness).toEqual({ reason: "never-run", stale: true });
    expect(report.verification.stale).toBe(true);
    expect(report.verification.read?.kind).toBe("never-run");
  });

  it("never claims the index is fresh, only that it exists", async () => {
    // Confirming freshness needs the full tree hash, which this deliberately
    // does not pay for. "unknown" is the strongest honest answer.
    headValue = {
      chunks: 12,
      merkleRoot: "root",
      model: "openai/text-embedding-3-small",
      updated: "2026-01-01T00:00:00.000Z",
    };

    const report = await collectOrientStaleness({ root });
    expect(report.index.stale).toBe("unknown");
    expect(report.index.status?.indexed).toBe(true);
    expect(report.index.status?.chunks).toBe(12);
  });

  it("finds a wiki record current against an unchanged, clean HEAD", async () => {
    const sha = gitInit(root);
    await writeWikiStatus({
      capturedAt: "2026-01-01T00:00:00.000Z",
      commitSha: sha,
      dirty: false,
      root,
    });

    const report = await collectOrientStaleness({ root });
    expect(report.wiki.currentCommitSha).toBe(sha);
    expect(report.wiki.currentDirty).toBe(false);
    expect(report.wiki.staleness.stale).toBe(false);
  });

  it("sees the working tree as dirty once a file is written", async () => {
    gitInit(root);
    writeFileSync(join(root, "README.md"), "changed\n", "utf8");

    const report = await collectOrientStaleness({ root });
    expect(report.wiki.currentDirty).toBe(true);
  });

  it("finds verification current against its own digest and stale after an edit", async () => {
    const first = await collectOrientStaleness({ root });
    // Record whatever the tree currently digests to, then assert it reads back
    // as current — a round trip through the real discovery module, not a
    // fabricated digest.
    const { signals, inputsDigest } = await import("@/lib/verification-signals/discover").then(
      (m) => m.discoverVerificationSignals({ root }),
    );
    expect(first.verification.stale).toBe(true);

    await writeVerificationStatus({
      capturedAt: "2026-01-01T00:00:00.000Z",
      inputsDigest,
      root,
      signals,
    });
    expect((await collectOrientStaleness({ root })).verification.stale).toBe(false);

    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: { lint: "oxlint", test: "vitest run" } }),
      "utf8",
    );
    expect((await collectOrientStaleness({ root })).verification.stale).toBe(true);
  });

  it("does not throw for a project directory that does not exist", async () => {
    // The prompt nudge calls this on every turn; a stale session link or a
    // deleted checkout must degrade to a report, not an exception.
    const report = await collectOrientStaleness({ root: join(root, "gone") });
    expect(report.wiki.staleness.stale).toBe(true);
    expect(report.verification.stale).toBe(true);
  });

  it("skips the digest when asked, without claiming freshness", async () => {
    const report = await collectOrientStaleness({ root, skipVerificationDigest: true });
    expect(report.verification.currentDigest).toBeNull();
    expect(report.verification.stale).toBe(true);
  });
});

describe("describeStalePhases", () => {
  it("names each stale phase once, with an actionable reason", async () => {
    const lines = describeStalePhases(await collectOrientStaleness({ root }));

    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("never indexed");
    expect(lines[1]).toContain("orient` skill");
    expect(lines[2]).toContain("verification-signals");
  });

  it("says nothing when every phase is current", async () => {
    const sha = gitInit(root);
    headValue = {
      chunks: 1,
      merkleRoot: "root",
      model: "m",
      updated: "2026-01-01T00:00:00.000Z",
    };
    await writeWikiStatus({
      capturedAt: "2026-01-01T00:00:00.000Z",
      commitSha: sha,
      dirty: false,
      root,
    });
    const { signals, inputsDigest } = await import(
      "@/lib/verification-signals/discover"
    ).then((m) => m.discoverVerificationSignals({ root }));
    await writeVerificationStatus({
      capturedAt: "2026-01-01T00:00:00.000Z",
      inputsDigest,
      root,
      signals,
    });

    // An index that exists reports "unknown", which is deliberately not a
    // nudge: nudging every turn on a fact that can never be confirmed cheaply
    // would make the section wallpaper.
    expect(describeStalePhases(await collectOrientStaleness({ root }))).toEqual([]);
  });
});
