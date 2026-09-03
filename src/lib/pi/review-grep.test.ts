/**
 * The parser against captured `git grep -z -n` output, and the search itself
 * against a real repository — including the two cases that would be silent
 * failures: a query that looks like a flag, and a path containing a colon.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  grepProject,
  MIN_QUERY_LENGTH,
  parseGrepOutput,
  parseRipgrepOutput,
  ripgrepAvailable,
} from "./review-grep.ts";

describe("parseGrepOutput", () => {
  it("reads path, line and text from the NUL-separated form", () => {
    const output =
      "src/lib/pi/review-service.ts\x0025\x00  readTurnMark,\n" +
      "src/lib/pi/review-service.ts\x00110\x00  const mark = readTurnMark(id);\n";

    expect(parseGrepOutput(output)).toEqual([
      { line: 25, path: "src/lib/pi/review-service.ts", text: "readTurnMark," },
      {
        line: 110,
        path: "src/lib/pi/review-service.ts",
        text: "const mark = readTurnMark(id);",
      },
    ]);
  });

  it("keeps a colon in the matching line intact", () => {
    // The reason for -z. With colon separators, `a: b` in the text makes the
    // field boundaries ambiguous and the parse silently wrong.
    const output = "a.ts\x001\x00const x = { a: 1, b: 2 };\n";
    expect(parseGrepOutput(output)[0]).toEqual({
      line: 1,
      path: "a.ts",
      text: "const x = { a: 1, b: 2 };",
    });
  });

  it("keeps a colon in the path intact", () => {
    const output = "docs/a:b.md\x007\x00text\n";
    expect(parseGrepOutput(output)[0].path).toBe("docs/a:b.md");
  });

  it("trims indentation, which is noise in a one-line preview", () => {
    const output = "a.ts\x001\x00        deeply.indented();\n";
    expect(parseGrepOutput(output)[0].text).toBe("deeply.indented();");
  });

  it("reads nothing from empty output", () => {
    expect(parseGrepOutput("")).toEqual([]);
  });

  it("skips a malformed record rather than emitting a bad match", () => {
    expect(parseGrepOutput("no-separators-here\n")).toEqual([]);
    expect(parseGrepOutput("a.ts\x00notanumber\x00text\n")).toEqual([]);
  });
});

describe("grepProject against a real repository", () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "semla-grep-"));
    const run = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8" });

    run("init", "-q", ".");
    run("config", "user.email", "test@example.com");
    run("config", "user.name", "Test");

    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(
      join(repo, "src/tracked.ts"),
      "export const needle = 1;\nconst other = 2;\nconst NEEDLE_UPPER = 3;\n",
    );
    writeFileSync(join(repo, "src/dashes.css"), ".a { transform: rotateX(-14deg); }\n");
    writeFileSync(join(repo, ".gitignore"), "ignored/\n");
    mkdirSync(join(repo, "ignored"), { recursive: true });
    writeFileSync(join(repo, "ignored/hidden.ts"), "export const needle = 99;\n");
    run("add", "-A");
    run("commit", "-qm", "initial");

    // Created after the commit: exactly the file a reviewer is looking for.
    writeFileSync(join(repo, "src/fresh.ts"), "export const needle = 42;\n");
  });

  afterAll(() => rmSync(repo, { force: true, recursive: true }));

  it("finds a match in a tracked file, with its line number", async () => {
    const { matches } = await grepProject(repo, "export const needle");
    const tracked = matches.find((m) => m.path === "src/tracked.ts");

    expect(tracked).toEqual({
      line: 1,
      path: "src/tracked.ts",
      text: "export const needle = 1;",
    });
  });

  it("finds a match in a file the turn just created", async () => {
    // --untracked. Without it the newest and most interesting files are
    // exactly the ones a content search cannot see.
    const { matches } = await grepProject(repo, "needle = 42");
    expect(matches.map((m) => m.path)).toContain("src/fresh.ts");
  });

  it("does not search ignored files", async () => {
    const { matches } = await grepProject(repo, "needle = 99");
    expect(matches).toEqual([]);
  });

  it("is case-insensitive", async () => {
    const { matches } = await grepProject(repo, "NeEdLe_UpPeR");
    expect(matches.map((m) => m.line)).toContain(3);
  });

  it("treats a query beginning with a dash as a search term, not a flag", async () => {
    // Without `-e` this is `git grep -14deg`, which fails as an unknown option
    // and would surface as "no matches" — a silent wrong answer.
    const { matches } = await grepProject(repo, "-14deg");
    expect(matches.map((m) => m.path)).toEqual(["src/dashes.css"]);
  });

  it("treats the query literally rather than as a regular expression", async () => {
    // A filter box: `rotateX(` should look for `rotateX(`, not raise an
    // unmatched-parenthesis error or match something else.
    const { matches } = await grepProject(repo, "rotateX(-14deg)");
    expect(matches).toHaveLength(1);
  });

  it("declines a query too short to be worth a full sweep", async () => {
    const short = "n".repeat(MIN_QUERY_LENGTH - 1);
    expect(await grepProject(repo, short)).toEqual({
      matches: [],
      truncated: false,
    });
  });

  it("reports no matches rather than failing when there are none", async () => {
    // git grep exits non-zero on no matches, which is the common case.
    expect(await grepProject(repo, "nothingmatchesthis")).toEqual({
      matches: [],
      truncated: false,
    });
  });

  it("reports nothing outside a repository instead of throwing", async () => {
    const plain = mkdtempSync(join(tmpdir(), "semla-plain-grep-"));
    try {
      expect(await grepProject(plain, "needle")).toEqual({
        matches: [],
        truncated: false,
      });
    } finally {
      rmSync(plain, { force: true, recursive: true });
    }
  });
});


describe("parseRipgrepOutput", () => {
  it("reads ripgrep's shape, which is not git grep's", () => {
    // ripgrep puts the NUL after the path only and leaves `line:text`
    // colon-separated. Parsing it as git grep's three NUL fields yields no
    // matches at all — a silent empty result rather than an error.
    const output = "./src/a.ts\x0025:  readTurnMark,\n";

    expect(parseRipgrepOutput(output)).toEqual([
      { line: 25, path: "src/a.ts", text: "readTurnMark," },
    ]);
  });

  it("strips the ./ the search root adds", () => {
    expect(parseRipgrepOutput("./a.ts\x001:x\n")[0].path).toBe("a.ts");
  });

  it("keeps colons in the matching line", () => {
    // The line number is numeric and first, so only the first colon separates.
    const out = parseRipgrepOutput("./a.ts\x0012:const x = { a: 1 };\n")[0];
    expect(out).toEqual({ line: 12, path: "a.ts", text: "const x = { a: 1 };" });
  });

  it("keeps colons in the path", () => {
    expect(parseRipgrepOutput("./docs/a:b.md\x007:text\n")[0]).toEqual({
      line: 7,
      path: "docs/a:b.md",
      text: "text",
    });
  });

  it("skips malformed records", () => {
    expect(parseRipgrepOutput("nonul\n")).toEqual([]);
    expect(parseRipgrepOutput("./a.ts\x00nope:text\n")).toEqual([]);
    expect(parseRipgrepOutput("")).toEqual([]);
  });
});

describe("the ripgrep binary", () => {
  it("is installed for this platform", () => {
    // @vscode/ripgrep ships it as a per-platform optional dependency, and an
    // optional dependency is precisely the kind an install can skip. If this
    // fails, content search still works — it falls back to git grep at about a
    // third of the speed — but the fallback should be a surprise worth seeing,
    // not the silent normal case.
    expect(ripgrepAvailable()).toBe(true);
  });
});

describe("the two engines agree", () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "semla-engines-"));
    const run = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    run("init", "-q", ".");
    run("config", "user.email", "t@example.com");
    run("config", "user.name", "T");

    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src/one.ts"), "const target = 1;\nconst t2 = 'target';\n");
    writeFileSync(join(repo, "src/two.ts"), "// target here\n");
    writeFileSync(join(repo, ".gitignore"), "skip/\n");
    mkdirSync(join(repo, "skip"), { recursive: true });
    writeFileSync(join(repo, "skip/no.ts"), "const target = 'ignored';\n");
    run("add", "-A");
    run("commit", "-qm", "init");
    writeFileSync(join(repo, "src/new.ts"), "const target = 3;\n");
  });

  afterAll(() => rmSync(repo, { force: true, recursive: true }));

  /** git grep, parsed the way grepProject's fallback path parses it. */
  const viaGitGrep = () => {
    const out = execFileSync(
      "git",
      [
        "grep", "-z", "--line-number", "-I", "--fixed-strings", "--ignore-case",
        "--untracked", "--max-count=5", "-e", "target", "--",
      ],
      { cwd: repo, encoding: "utf8" },
    );
    return parseGrepOutput(out);
  };

  it("finds the same lines whichever engine runs", async () => {
    // The fallback exists so a missing binary costs speed and not correctness.
    // That claim is only worth anything if it is checked.
    const rg = (await grepProject(repo, "target")).matches;
    const git = viaGitGrep();

    const key = (m: { line: number; path: string }) => `${m.path}:${m.line}`;
    expect(new Set(rg.map(key))).toEqual(new Set(git.map(key)));
    expect(rg.length).toBeGreaterThan(0);
  });

  it("both skip what .gitignore excludes", async () => {
    const rg = (await grepProject(repo, "target")).matches;
    expect(rg.some((m) => m.path.startsWith("skip/"))).toBe(false);
    expect(viaGitGrep().some((m) => m.path.startsWith("skip/"))).toBe(false);
  });

  it("both see a file created after the last commit", async () => {
    const rg = (await grepProject(repo, "target")).matches;
    expect(rg.map((m) => m.path)).toContain("src/new.ts");
    expect(viaGitGrep().map((m) => m.path)).toContain("src/new.ts");
  });
});
