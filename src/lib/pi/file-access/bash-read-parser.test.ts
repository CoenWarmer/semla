/**
 * Fixtures are taken verbatim from the corpus this parser was measured on —
 * 4 237 bash commands across the forty largest sessions in `.semla-sessions/`.
 * Precision is a property of these cases, not a threshold in CI: a number
 * asserted against a corpus that is not in the repository would rot.
 */

import { describe, expect, it } from "vitest";

import { parseBashAccesses, stripHeredocs } from "./bash-read-parser.ts";

const paths = (command: string) =>
  parseBashAccesses(command).map((access) => access.rawPath);

describe("line ranges", () => {
  it("reads an exact range out of sed -n", () => {
    // The most valuable pattern in the corpus: the agent paging through a file.
    expect(parseBashAccesses("sed -n 330,400p src/x.ts")).toEqual([
      {
        confidence: "inferred",
        kind: "read",
        ranges: [{ end: 400, start: 330 }],
        rawPath: "src/x.ts",
        tool: "bash",
      },
    ]);
  });

  it("handles sed's quoted script form", () => {
    const [access] = parseBashAccesses("sed -n '1,60p' src/x.ts");
    expect(access?.ranges).toEqual([{ end: 60, start: 1 }]);
  });

  it("reads a single line", () => {
    const [access] = parseBashAccesses("sed -n '42p' src/x.ts");
    expect(access?.ranges).toEqual([{ end: 42, start: 42 }]);
  });

  it("counts head from the top, defaulting to ten lines", () => {
    expect(parseBashAccesses("head src/x.ts")[0]?.ranges).toEqual([
      { end: 10, start: 1 },
    ]);
    expect(parseBashAccesses("head -n 50 src/x.ts")[0]?.ranges).toEqual([
      { end: 50, start: 1 },
    ]);
    expect(parseBashAccesses("head -20 src/x.ts")[0]?.ranges).toEqual([
      { end: 20, start: 1 },
    ]);
  });

  it("knows where tail -n +N starts but not where tail -n N does", () => {
    expect(parseBashAccesses("tail -n +200 src/x.ts")[0]?.ranges).toEqual([
      { end: null, start: 200 },
    ]);
    // Counting back from the end needs the file's length, and the file may
    // since have changed length. A whole-file read is the honest answer.
    expect(parseBashAccesses("tail -n 20 src/x.ts")[0]?.ranges).toEqual([]);
  });

  it("reads a bounded awk range", () => {
    expect(
      parseBashAccesses("awk 'NR>=100 && NR<=200' src/x.ts")[0]?.ranges,
    ).toEqual([{ end: 200, start: 100 }]);
  });
});

describe("cwd tracking", () => {
  it("joins a read onto the directory the command cd'd into", () => {
    // Without this, a bare basename after a cd resolves to nothing: extraction
    // accuracy measured 69% without cwd tracking and 86% with it.
    expect(
      paths("cd /Users/coen/Dev/semla && sed -n 330,400p src/x.ts"),
    ).toEqual(["/Users/coen/Dev/semla/src/x.ts"]);
  });

  it("joins relative cd segments onto each other", () => {
    expect(paths("cd semla && cd src/lib && cat token.ts")).toEqual([
      "semla/src/lib/token.ts",
    ]);
  });

  it("leaves a path alone when nothing cd'd", () => {
    expect(paths("cat src/x.ts")).toEqual(["src/x.ts"]);
  });
});

describe("heredocs", () => {
  it("does not harvest paths out of an embedded script", () => {
    // 4% of corpus commands contain `<<`, and the bodies are JavaScript and
    // Python. Splitting before stripping puts `const` and `import` among the
    // most common shell verbs and mines every string literal for paths.
    const command = [
      "cd semla && python3 - <<'PY'",
      "import json",
      "d = json.load(open('src/secret-not-read.json'))",
      "print(d)",
      "PY",
    ].join("\n");

    expect(paths(command)).toEqual([]);
  });

  it("still reads the command that introduced the heredoc", () => {
    const command = ["cat src/real.ts && node - <<'JS'", "require('./fake.ts')", "JS"].join(
      "\n",
    );
    expect(paths(command)).toEqual(["src/real.ts"]);
  });

  it("swallows an unterminated heredoc rather than mining its body", () => {
    expect(stripHeredocs("node - <<'JS'\nrequire('./x.ts')").trim()).toBe(
      "node -",
    );
  });
});

describe("path tokens", () => {
  it("does not truncate .jsonl to .js", () => {
    // An earlier alternation ordered `js` before `jsonl` and turned
    // `events.jsonl` into `events.js`, costing fourteen points of apparent
    // precision and producing no errors at all.
    expect(paths("cat .semla-debug/sessions/abc/events.jsonl")).toEqual([
      ".semla-debug/sessions/abc/events.jsonl",
    ]);
  });

  it("ignores a glob rather than reading it as a file", () => {
    expect(paths('grep -rn "x" src --include=*.ts')).toEqual([]);
  });

  it("ignores a path inside a quoted grep pattern", () => {
    // Common in this corpus, and it is not a file the command read.
    expect(paths(`grep -n "from './other.ts'" src/x.ts`)).toEqual(["src/x.ts"]);
  });
});

describe("writes", () => {
  it("classifies a redirect as a write", () => {
    expect(parseBashAccesses("echo hi > notes/out.md")).toEqual([
      {
        confidence: "inferred",
        kind: "write",
        ranges: [],
        rawPath: "notes/out.md",
        tool: "bash",
      },
    ]);
  });

  it("classifies sed -i as a write, not a read", () => {
    const accesses = parseBashAccesses("sed -i '' 's/a/b/' src/x.ts");
    expect(accesses.map((access) => access.kind)).toEqual(["write"]);
  });

  it("classifies tee as a write", () => {
    expect(parseBashAccesses("cmd | tee -a build/log.txt")[0]?.kind).toBe(
      "write",
    );
  });

  it("records both sides of a read redirected into a write", () => {
    expect(parseBashAccesses("cat src/a.ts > src/b.ts")).toEqual([
      expect.objectContaining({ kind: "read", rawPath: "src/a.ts" }),
      expect.objectContaining({ kind: "write", rawPath: "src/b.ts" }),
    ]);
  });
});

describe("volume", () => {
  it("collapses a repeated read of the same range", () => {
    expect(paths("cat src/x.ts && cat src/x.ts")).toEqual(["src/x.ts"]);
  });

  it("keeps two different ranges of one file apart", () => {
    expect(
      parseBashAccesses("sed -n 1,10p src/x.ts; sed -n 20,30p src/x.ts").map(
        (access) => access.ranges,
      ),
    ).toEqual([[{ end: 10, start: 1 }], [{ end: 30, start: 20 }]]);
  });

  it("caps one command's contribution", () => {
    // The longest command in the corpus split into 266 segments. Fifty
    // scrubber stops from one action would bury the turn's real reads.
    const command = Array.from(
      { length: 120 },
      (_unused, index) => `cat src/file-${index}.ts`,
    ).join(" && ");

    expect(parseBashAccesses(command)).toHaveLength(50);
  });
});

describe("commands that read no single file", () => {
  it("yields nothing for a directory search", () => {
    expect(paths('grep -rn "ReviewPanel" src --include=*.tsx -l')).toEqual([]);
  });

  it("yields nothing for a bare listing", () => {
    expect(paths("cd semla && ls src/components | head -50")).toEqual([]);
  });
});
