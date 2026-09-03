/**
 * Fixtures here are real `git` output, captured from a repository built to
 * contain each case, not written from the documentation. The rename ordering
 * in §parsePorcelain is the reason: the two formats disagree, and only one of
 * them is what `-z` actually emits.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const gitMock = vi.hoisted(() => vi.fn());
const gitRawMock = vi.hoisted(() => vi.fn());
const gitResultMock = vi.hoisted(() => vi.fn());

vi.mock("./git", () => ({
  git: gitMock,
  gitRaw: gitRawMock,
  gitResult: gitResultMock,
}));

const {
  parsePorcelain,
  parseTurnCommits,
  readChangedFiles,
  readTurnCommits,
  statusFromCodes,
} = await import("./review-status.ts");

/** Exactly what `git status --porcelain=v1 -z --untracked-files=all` printed. */
const PORCELAIN =
  " D gone.txt\0 M mod.txt\0R  renamed.txt\0ren.txt\0A  staged.txt\0" +
  "?? has space.txt\0?? new.txt\0?? ünïcode.txt\0";

beforeEach(() => {
  gitMock.mockReset();
  gitRawMock.mockReset();
  gitResultMock.mockReset();
});

describe("statusFromCodes", () => {
  it("reads the pairs git actually emits", () => {
    expect(statusFromCodes("?", "?")).toBe("untracked");
    expect(statusFromCodes(" ", "D")).toBe("deleted");
    expect(statusFromCodes(" ", "M")).toBe("modified");
    expect(statusFromCodes("R", " ")).toBe("renamed");
    expect(statusFromCodes("A", " ")).toBe("added");
    expect(statusFromCodes("C", " ")).toBe("copied");
    expect(statusFromCodes(" ", "T")).toBe("type-changed");
  });

  it("calls a conflict a conflict rather than guessing from one column", () => {
    for (const pair of ["DD", "AU", "UD", "UA", "DU", "AA", "UU"]) {
      expect(statusFromCodes(pair[0], pair[1])).toBe("unmerged");
    }
  });

  it("prefers the worktree column, which describes the file on disk now", () => {
    // Staged, then modified again. Either column says "modified".
    expect(statusFromCodes("M", "M")).toBe("modified");
  });

  it("keeps a new file 'added' after it is edited again", () => {
    // AM is more usefully "added" than "modified": the file did not exist.
    expect(statusFromCodes("A", "M")).toBe("added");
  });
});

describe("parsePorcelain", () => {
  it("reads every entry from real -z output", () => {
    expect(parsePorcelain(PORCELAIN).map((file) => file.path)).toEqual([
      "gone.txt",
      "mod.txt",
      "renamed.txt",
      "staged.txt",
      "has space.txt",
      "new.txt",
      "ünïcode.txt",
    ]);
  });

  it("takes a rename's new path first and the original second", () => {
    // The trap. `-z` prints "R  renamed.txt\0ren.txt", while the human format
    // prints "R  ren.txt -> renamed.txt". Reading the docs for one and testing
    // against the other reports every rename backwards.
    const rename = parsePorcelain(PORCELAIN).find(
      (file) => file.status === "renamed",
    );
    expect(rename).toMatchObject({ oldPath: "ren.txt", path: "renamed.txt" });
  });

  it("does not read a rename's original path as an entry of its own", () => {
    expect(parsePorcelain(PORCELAIN).map((f) => f.path)).not.toContain(
      "ren.txt",
    );
  });

  it("leaves paths with spaces and non-ASCII bytes exactly as git wrote them", () => {
    // What -z buys: the human format quotes and octal-escapes both of these.
    const paths = parsePorcelain(PORCELAIN).map((file) => file.path);
    expect(paths).toContain("has space.txt");
    expect(paths).toContain("ünïcode.txt");
  });

  it("marks what a commit would and would not currently include", () => {
    const byPath = new Map(
      parsePorcelain(PORCELAIN).map((file) => [file.path, file]),
    );
    expect(byPath.get("staged.txt")).toMatchObject({
      staged: true,
      unstaged: false,
    });
    expect(byPath.get("mod.txt")).toMatchObject({
      staged: false,
      unstaged: true,
    });
    // Outside the index entirely, so neither column describes it — but a
    // commit will not include it, which is what unstaged means here.
    expect(byPath.get("new.txt")).toMatchObject({
      staged: false,
      unstaged: true,
    });
  });

  it("reads nothing from a clean tree", () => {
    expect(parsePorcelain("")).toEqual([]);
  });
});

describe("readChangedFiles", () => {
  it("caps the list and says how many it left out", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ` M f${i}.ts`).join("\0");
    gitRawMock.mockResolvedValue(many);

    const result = await readChangedFiles("/repo", 5);

    expect(result.files).toHaveLength(5);
    expect(result.omitted).toBe(7);
  });

  it("asks for every untracked file, not a collapsed directory", async () => {
    gitRawMock.mockResolvedValue("");
    await readChangedFiles("/repo");
    expect(gitRawMock.mock.calls[0][1]).toContain("--untracked-files=all");
  });

  it("reads porcelain untrimmed, or the first entry is corrupted", async () => {
    // The bug this guards: `git` trims, so " D gone.txt" arrives as
    // "D gone.txt", every field shifts by one and the path loses its first
    // character. Only `gitRaw` preserves the leading status column.
    gitRawMock.mockResolvedValue(" D gone.txt\0 M mod.ts\0");

    const { files } = await readChangedFiles("/repo");

    expect(files[0]).toMatchObject({ path: "gone.txt", status: "deleted" });
    expect(gitMock).not.toHaveBeenCalled();
  });

  it("reports nothing rather than throwing when git cannot answer", async () => {
    gitRawMock.mockResolvedValue(null);
    expect(await readChangedFiles("/repo")).toEqual({ files: [], omitted: 0 });
  });
});

describe("parseTurnCommits", () => {
  /** Real `git log --format=%x1e...%aI --name-only` output for two commits. */
  const LOG =
    "\x1ea1d4e530242bc5c1f04beb02cbca8634d754099f\x1fa1d4e53\x1f" +
    "third: two files\x1ft\x1f2026-09-03T14:55:35+02:00\n\nkeep.txt\n" +
    "\x1e1c0aa73e52c50f0dab9e60d338d935698e671dda\x1f1c0aa73\x1f" +
    "second\x1ft\x1f2026-09-03T14:55:35+02:00\n\nmod.txt\nnew.txt\n";

  it("reads each commit and counts its files", () => {
    expect(parseTurnCommits(LOG)).toEqual([
      {
        at: "2026-09-03T14:55:35+02:00",
        author: "t",
        fileCount: 1,
        sha: "a1d4e530242bc5c1f04beb02cbca8634d754099f",
        shortSha: "a1d4e53",
        subject: "third: two files",
      },
      {
        at: "2026-09-03T14:55:35+02:00",
        author: "t",
        fileCount: 2,
        sha: "1c0aa73e52c50f0dab9e60d338d935698e671dda",
        shortSha: "1c0aa73",
        subject: "second",
      },
    ]);
  });

  it("reads nothing from an empty range", () => {
    expect(parseTurnCommits("")).toEqual([]);
  });
});

describe("readTurnCommits", () => {
  it("has no range without a start sha, and does not invent one", async () => {
    expect(await readTurnCommits("/repo", null)).toEqual([]);
    expect(gitMock).not.toHaveBeenCalled();
  });

  it("checks ancestry with gitResult, because --is-ancestor prints nothing", async () => {
    // `git` collapses empty stdout to null exactly as it does a failure, so
    // using it here would read every range as "not an ancestor" and the panel
    // would never show a commit.
    gitResultMock.mockResolvedValue({ ok: true, stderr: "", stdout: "" });
    gitMock.mockResolvedValue("");

    await readTurnCommits("/repo", "abc123");

    expect(gitResultMock.mock.calls[0][1]).toEqual([
      "merge-base",
      "--is-ancestor",
      "abc123",
      "HEAD",
    ]);
    expect(gitMock).toHaveBeenCalled();
  });

  it("refuses a start sha that is not an ancestor of HEAD", async () => {
    // A branch rebased or reset since the turn began: `start..HEAD` would
    // quietly describe a different set of commits.
    gitResultMock.mockResolvedValue({ ok: false, stderr: "", stdout: "" });

    expect(await readTurnCommits("/repo", "abc123")).toEqual([]);
    expect(gitMock).not.toHaveBeenCalled();
  });
});
