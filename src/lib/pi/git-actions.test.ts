import { beforeEach, describe, expect, it, vi } from "vitest";

const gitResultMock = vi.hoisted(() => vi.fn());
vi.mock("./git", () => ({ gitResult: gitResultMock }));

const { checkoutBranch, explainGitFailure, mergeIntoCurrent } =
  await import("./git-actions");

/** Merge now fetches first, so the merge itself is the second call. */
const MERGE_CALL = 2;

const ok = (stdout = "") => ({ ok: true, stdout, stderr: "" });
const fail = (stderr: string) => ({ ok: false, stdout: "", stderr });

describe("mergeIntoCurrent", () => {
  beforeEach(() => gitResultMock.mockReset());

  it("merges the base without opening an editor", async () => {
    gitResultMock.mockResolvedValue(ok("Fast-forward"));
    const result = await mergeIntoCurrent("/repo", "upstream/main");

    // Fetch the branch, then merge it. Merging a stale tracking ref is the
    // whole failure this ordering exists to prevent.
    expect(gitResultMock).toHaveBeenNthCalledWith(
      1,
      "/repo",
      ["fetch", "upstream", "main", "--quiet", "--no-tags"],
      expect.objectContaining({ network: true }),
    );
    expect(gitResultMock).toHaveBeenNthCalledWith(
      MERGE_CALL,
      "/repo",
      ["merge", "--no-edit", "upstream/main"],
      expect.anything(),
    );
    expect(result).toEqual({ ok: true, message: "Merged upstream/main." });
  });

  it("says so when the remote could not be reached", async () => {
    // Offline still merges what is on disk, but must not imply it is current.
    gitResultMock
      .mockResolvedValueOnce(fail("ssh: Could not resolve hostname"))
      .mockResolvedValueOnce(ok("Fast-forward"));
    const result = await mergeIntoCurrent("/repo", "upstream/main");
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Could not reach upstream");
  });

  it("distinguishes a no-op from a real merge", async () => {
    gitResultMock.mockResolvedValue(ok("Already up to date."));
    const result = await mergeIntoCurrent("/repo", "origin/main");
    expect(result.message).toBe("Already up to date with origin/main.");
  });

  it("rolls a conflict back instead of leaving the repo mid-merge", async () => {
    gitResultMock
      .mockResolvedValueOnce(ok()) // fetch
      .mockResolvedValueOnce(fail("CONFLICT (content): Merge conflict in a.txt"))
      .mockResolvedValueOnce(ok());

    const result = await mergeIntoCurrent("/repo", "upstream/main");

    expect(gitResultMock).toHaveBeenNthCalledWith(3, "/repo", ["merge", "--abort"]);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("CONFLICT");
    expect(result.message).toContain("Merge rolled back.");
  });

  it("reports a refusal to overwrite local changes", async () => {
    gitResultMock
      .mockResolvedValueOnce(ok()) // fetch
      .mockResolvedValueOnce(
        fail("error: Your local changes would be overwritten by merge."),
      )
      .mockResolvedValueOnce(fail("fatal: There is no merge to abort"));

    const result = await mergeIntoCurrent("/repo", "origin/main");

    expect(result.ok).toBe(false);
    expect(result.message).toContain("local changes would be overwritten");
    // Nothing was rolled back because nothing had started.
    expect(result.message).not.toContain("rolled back");
  });

  it("skips git's hint lines when picking the reason", async () => {
    gitResultMock
      .mockResolvedValueOnce(ok()) // fetch
      .mockResolvedValueOnce(fail("hint: use --no-ff\nerror: the real problem"))
      .mockResolvedValueOnce(ok());
    const result = await mergeIntoCurrent("/repo", "origin/main");
    expect(result.message).toContain("the real problem");
  });
});

describe("checkoutBranch", () => {
  beforeEach(() => gitResultMock.mockReset());

  it("switches branch", async () => {
    gitResultMock.mockResolvedValue(ok("Switched to branch 'main'"));
    const result = await checkoutBranch("/repo", "main");
    expect(gitResultMock).toHaveBeenCalledWith("/repo", ["checkout", "main"]);
    expect(result).toEqual({ ok: true, message: "Checked out main." });
  });

  it("surfaces git's refusal rather than forcing it", async () => {
    // No --force anywhere: git declining to discard work is the safe outcome.
    gitResultMock.mockResolvedValue(
      fail("error: Your local changes to 'a.txt' would be overwritten"),
    );
    const result = await checkoutBranch("/repo", "main");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("would be overwritten");
  });
});

describe("explainGitFailure", () => {
  it("names the conflict, not the file that merged first", () => {
    // A conflicted merge opens with a line about the step that succeeded.
    expect(
      explainGitFailure(
        "Auto-merging c.txt\nCONFLICT (add/add): Merge conflict in c.txt",
      ),
    ).toBe("CONFLICT (add/add): Merge conflict in c.txt");
  });

  it("prefers an error line over incidental output", () => {
    expect(explainGitFailure("Updating a..b\nerror: cannot do that")).toBe(
      "error: cannot do that",
    );
  });

  it("ignores git's hints", () => {
    expect(explainGitFailure("hint: try --no-ff\nfatal: bad thing")).toBe(
      "fatal: bad thing",
    );
  });

  it("always says something", () => {
    expect(explainGitFailure("")).toBe("git failed");
  });
});
