/**
 * The reset guards, against real repositories.
 *
 * This is the only destructive operation in the review feature, so each guard
 * is asserted by putting a real repository into the state it refuses and
 * checking that it does. A guard that is only unit-tested against a mock is a
 * guard that has never met the condition it exists for.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { performReset, planReset } from "./review-reset.ts";

let repo: string;
let startSha: string;

const at = (dir: string) =>
  (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();

let run: (...args: string[]) => string;

const write = (name: string, body: string) =>
  writeFileSync(join(repo, name), body);

/** A repository with two agent commits on top of a recorded start point. */
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "semla-reset-"));
  run = at(repo);
  run("init", "-q", "-b", "main", ".");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test");
  run("config", "commit.gpgsign", "false");

  write("file.txt", "one\n");
  run("add", "-A");
  run("commit", "-qm", "initial");
  startSha = run("rev-parse", "HEAD");

  write("file.txt", "one\ntwo\n");
  run("add", "-A");
  run("commit", "-qm", "[Agent]: add two");
  write("file.txt", "one\ntwo\nthree\n");
  run("add", "-A");
  run("commit", "-qm", "[Agent]: add three");
});

describe("planReset refusals", () => {
  it("refuses without a recorded start, rather than guessing one", async () => {
    const plan = await planReset(repo, null);
    expect(plan.allowed).toBe(false);
    expect(plan.message).toContain("did not record");
  });

  it("refuses when the agent committed nothing", async () => {
    const plan = await planReset(repo, run("rev-parse", "HEAD"));
    expect(plan.allowed).toBe(false);
    expect(plan.message).toContain("no commits");
  });

  it("refuses a start sha that is not an ancestor of HEAD", async () => {
    const orphan = run(
      "commit-tree",
      run("rev-parse", "HEAD^{tree}"),
      "-m",
      "unrelated",
    );
    const plan = await planReset(repo, orphan);
    expect(plan.allowed).toBe(false);
    expect(plan.message).toContain("moved since the turn began");
  });

  it("refuses on a detached HEAD, which has no branch to move", async () => {
    run("checkout", "-q", "--detach", "HEAD");
    const plan = await planReset(repo, startSha);
    expect(plan.allowed).toBe(false);
    expect(plan.message).toContain("detached");
  });

  it("refuses mid-merge", async () => {
    // A reset here would discard the state git needs to finish.
    writeFileSync(join(repo, ".git", "MERGE_HEAD"), `${startSha}\n`);
    const plan = await planReset(repo, startSha);
    expect(plan.allowed).toBe(false);
    expect(plan.message).toContain("merge is in progress");
  });

  it("refuses mid-rebase", async () => {
    execFileSync("mkdir", ["-p", join(repo, ".git", "rebase-merge")]);
    const plan = await planReset(repo, startSha);
    expect(plan.allowed).toBe(false);
    expect(plan.message).toContain("rebase is in progress");
  });

  it("refuses while another git process holds the index", async () => {
    writeFileSync(join(repo, ".git", "index.lock"), "");
    const plan = await planReset(repo, startSha);
    expect(plan.allowed).toBe(false);
    expect(plan.message).toContain("another git process");
  });

  it("refuses to undo a commit that is already on the tracking branch", async () => {
    // The guard that matters most: this would rewrite history other checkouts
    // already have, which is a decision the panel will not make.
    const remote = mkdtempSync(join(tmpdir(), "semla-remote-"));
    at(remote)("init", "-q", "--bare", ".");
    run("remote", "add", "origin", remote);
    run("push", "-q", "-u", "origin", "main");

    try {
      const plan = await planReset(repo, startSha);
      expect(plan.allowed).toBe(false);
      expect(plan.pushed).toBe(2);
      expect(plan.message).toContain("rewrite history");
      // It still reports what they are, so the operator can see the problem.
      expect(plan.commits).toHaveLength(2);
    } finally {
      rmSync(remote, { force: true, recursive: true });
    }
  });

  it("allows the reset when only local commits are involved", async () => {
    const plan = await planReset(repo, startSha);

    expect(plan.allowed).toBe(true);
    expect(plan.pushed).toBe(0);
    expect(plan.target).toBe(startSha);
    expect(plan.commits.map((commit) => commit.subject)).toEqual([
      "[Agent]: add three",
      "[Agent]: add two",
    ]);
  });

  it("reports an unpushed commit as unpushed even with a remote configured", async () => {
    const remote = mkdtempSync(join(tmpdir(), "semla-remote-"));
    at(remote)("init", "-q", "--bare", ".");
    run("remote", "add", "origin", remote);
    // Push the start point only: the agent's two commits are still local.
    run("push", "-q", "origin", `${startSha}:refs/heads/main`);
    run("branch", "--set-upstream-to=origin/main", "main");

    try {
      const plan = await planReset(repo, startSha);
      expect(plan.pushed).toBe(0);
      expect(plan.allowed).toBe(true);
    } finally {
      rmSync(remote, { force: true, recursive: true });
    }
  });

  it("says when there are uncommitted changes as well, without refusing", async () => {
    write("file.txt", "one\ntwo\nthree\nfour\n");
    const plan = await planReset(repo, startSha);

    expect(plan.allowed).toBe(true);
    expect(plan.dirty).toBe(true);
  });
});

describe("performReset", () => {
  it("moves the commits into the working tree and keeps their content", async () => {
    const result = await performReset(repo, startSha, startSha);

    expect(result.ok).toBe(true);
    expect(run("rev-parse", "HEAD")).toBe(startSha);
    // Unstaged, not staged: --mixed, so the hunk selection is still the
    // operator's to make. Asserted through `git diff` rather than porcelain
    // because the helper above trims, and porcelain's first column is a
    // space — the same trap gitRaw exists for.
    expect(run("diff", "--name-only")).toBe("file.txt");
    expect(run("diff", "--cached", "--name-only")).toBe("");
    // The content survived.
    expect(
      execFileSync("cat", [join(repo, "file.txt")], { encoding: "utf8" }),
    ).toBe("one\ntwo\nthree\n");
  });

  it("tells the operator the commits are still in the reflog", async () => {
    const result = await performReset(repo, startSha, startSha);
    expect(result.message).toContain("reflog");
    expect(run("reflog").split("\n").length).toBeGreaterThan(1);
  });

  it("refuses when the target it was shown is not the target now", async () => {
    // A panel left open across another turn: the range it is acting on no
    // longer describes anything.
    const result = await performReset(repo, startSha, "0".repeat(40));

    expect(result.ok).toBe(false);
    expect(result.message).toContain("moved since the panel read it");
    expect(run("rev-parse", "HEAD")).not.toBe(startSha);
  });

  it("re-derives the plan rather than trusting the caller", async () => {
    // Guards are only worth anything if they run against the repository as it
    // is at the moment of the write.
    run("checkout", "-q", "--detach", "HEAD");
    const result = await performReset(repo, startSha, startSha);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("detached");
  });
});
