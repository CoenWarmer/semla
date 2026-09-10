/**
 * Recovering file reads and writes from shell commands.
 *
 * The agent reads mostly through `bash`, not through `read`: across 4 237 bash
 * calls in the forty largest sessions on this machine, `bash` was 74% of all
 * tool traffic against 23% for `read`, `edit` and `write` combined. A scrubber
 * built only on typed tools would not be showing the operator what the agent
 * read, so this parser exists — knowing that it can be wrong, and saying so
 * through `confidence: "inferred"`.
 *
 * Three rules came out of measuring rather than reasoning:
 *
 * 1. **Strip heredocs first.** 4% of commands contain `<<`, and the bodies are
 *    JavaScript and Python. Splitting before stripping puts `const`, `import`
 *    and `console.log` among the most common "shell verbs" and harvests every
 *    path in an embedded string literal.
 * 2. **Track `cd`.** There were 3 924 `cd` segments in those 4 237 commands.
 *    Without cwd tracking a bare `agent.ts` after a `cd` resolves to nothing:
 *    extraction accuracy measured 69% without it and 86% with it.
 * 3. **Longest extension first.** An earlier alternation ordered `js` before
 *    `jsonl` and quietly turned `events.jsonl` into `events.js`, which cost
 *    fourteen points of apparent precision and no errors at all.
 *
 * Arguments only, never results. The read-router extension replaces large tool
 * results with cheap-model summaries before they are persisted, so results are
 * not a stable substrate. The cost is that `grep -n` yields the file but not the
 * matched lines and lands as a whole-file read — honest, where a line number
 * parsed out of a summary would not be.
 */

import { isAbsolute, join, normalize } from "node:path/posix";

import type { LineRange, RawAccess } from "./access-types";

/**
 * One command cannot contribute more than this many accesses.
 *
 * The longest command in the corpus split into 266 segments. A loop that greps
 * fifty files is one action by the operator's reckoning, and fifty scrubber
 * stops would bury the turn's real reads.
 */
const MAX_ACCESSES_PER_COMMAND = 50;

/** Longest first — see rule 3 above. */
const EXTENSIONS = [
  "tsx",
  "ts",
  "jsonl",
  "json",
  "jsx",
  "mjs",
  "mts",
  "cjs",
  "js",
  "md",
  "css",
  "scss",
  "sql",
  "yaml",
  "yml",
  "toml",
  "sh",
  "txt",
  "html",
].join("|");

/**
 * A path token ending in a known extension.
 *
 * The leading `/` is optional and load-bearing: without it an absolute
 * `/Users/…/x.ts` was captured as `Users/…/x.ts` and then joined onto the
 * command's cwd, producing a path that resolved nowhere. The corpus found it —
 * every absolute read in 4 237 commands was silently mangled.
 */
const PATH = String.raw`(/?(?:[\w.@~-]+/)*[\w.@~-]+\.(?:${EXTENSIONS}))(?![\w])`;

const path = (flags = "") => new RegExp(PATH, flags);

/**
 * Remove heredoc bodies, keeping the command that introduced them.
 *
 * Matches `<<WORD`, `<<'WORD'`, `<<"WORD"` and `<<-WORD`, up to a line holding
 * only the terminator. An unterminated heredoc — the agent's last command cut
 * short — swallows the rest of the string, which is the safe direction: it
 * yields nothing rather than yielding a body's contents as paths.
 */
export function stripHeredocs(command: string): string {
  // `(?![\s\S])` rather than `$`: under the `m` flag `$` is end of *line*, so
  // an unterminated heredoc would keep only its first line and the rest of the
  // body would still be mined for paths.
  return command.replace(
    /<<-?\s*(['"]?)(\w+)\1[\s\S]*?(?:^[\t ]*\2[\t ]*$|(?![\s\S]))/gm,
    " ",
  );
}

/**
 * Split a command into sequential segments.
 *
 * Quote-aware, because the separators occur inside arguments: an awk script
 * reading `'NR>=100 && NR<=200'` is one segment, and splitting it in half loses
 * both the range and the file. A regex `.split()` cannot see that.
 *
 * Backslash escapes are not tracked. A quote escaped inside a quoted run would
 * mis-split, which did not occur anywhere in the measured corpus.
 */
export function segments(command: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;

    if (quote !== null) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }

    if (command.startsWith("&&", index) || command.startsWith("||", index)) {
      out.push(current);
      current = "";
      index += 1;
      continue;
    }

    if (char === ";" || char === "\n" || char === "|") {
      out.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  out.push(current);
  return out.map((segment) => segment.trim()).filter((segment) => segment !== "");
}

/** Drop quoted runs, so a pattern's contents are not mistaken for operands. */
const unquote = (segment: string) =>
  segment.replace(/"[^"]*"|'[^']*'/g, " ");

const toInt = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

interface Found {
  rawPath: string;
  kind: "read" | "write";
  ranges: LineRange[];
}

/**
 * `sed`: an `-n` script selects lines, `-i` rewrites the file in place.
 *
 * Ordered before the generic matchers because `sed -n '330,400p' x.ts` is the
 * single most valuable pattern in the corpus — it is the agent paging through a
 * file, and it carries an exact range.
 */
function sedMatches(segment: string): Found[] {
  const found: Found[] = [];

  const range = new RegExp(
    String.raw`sed\s+-n\s+['"]?\s*(\d+),(\d+)p['"]?\s+` + PATH,
  ).exec(segment);
  if (range) {
    found.push({
      kind: "read",
      ranges: [{ end: toInt(range[2]), start: toInt(range[1]) ?? 1 }],
      rawPath: range[3]!,
    });
  }

  const single = new RegExp(
    String.raw`sed\s+-n\s+['"]?\s*(\d+)p['"]?\s+` + PATH,
  ).exec(segment);
  if (single && !range) {
    const line = toInt(single[1]) ?? 1;
    found.push({
      kind: "read",
      ranges: [{ end: line, start: line }],
      rawPath: single[2]!,
    });
  }

  for (const match of segment.matchAll(
    new RegExp(String.raw`sed\s+(?:-[a-zA-Z]*i[a-zA-Z]*)\s+[^|;&\n]*?` + PATH, "g"),
  )) {
    found.push({ kind: "write", ranges: [], rawPath: match[1]! });
  }

  return found;
}

/** `head -n N file` / `head -N file` / `head file` — always from the top. */
function headMatches(segment: string): Found[] {
  const match = new RegExp(
    String.raw`\bhead\s+(?:-n\s*(\d+)\s+|-(\d+)\s+)?` + PATH,
  ).exec(segment);
  if (!match) return [];

  // GNU and BSD both default to ten lines when no count is given.
  const count = toInt(match[1]) ?? toInt(match[2]) ?? 10;
  return [
    { kind: "read", ranges: [{ end: count, start: 1 }], rawPath: match[3]! },
  ];
}

/**
 * `tail`: `-n +N` starts at a line, plain `-n N` counts back from the end.
 *
 * The second cannot be turned into a range without knowing how long the file
 * is, and the file may since have changed length, so it lands as a whole-file
 * read rather than a guess.
 */
function tailMatches(segment: string): Found[] {
  const fromLine = new RegExp(
    String.raw`\btail\s+-n\s*\+(\d+)\s+` + PATH,
  ).exec(segment);
  if (fromLine) {
    return [
      {
        kind: "read",
        ranges: [{ end: null, start: toInt(fromLine[1]) ?? 1 }],
        rawPath: fromLine[2]!,
      },
    ];
  }

  const plain = new RegExp(
    String.raw`\btail\s+(?:-n\s*\d+\s+|-\d+\s+)?` + PATH,
  ).exec(segment);
  return plain ? [{ kind: "read", ranges: [], rawPath: plain[1]! }] : [];
}

/** `awk 'NR==N,NR==M'` and `awk 'NR>=N && NR<=M'`. */
function awkMatches(segment: string): Found[] {
  if (!/\bawk\b/.test(segment)) return [];

  const bounded =
    /NR\s*[=>]=\s*(\d+)\s*(?:,\s*NR\s*<?=\s*(\d+)|&&\s*NR\s*<=\s*(\d+))/.exec(
      segment,
    );
  const file = path().exec(unquote(segment));
  if (!file) return [];

  if (!bounded) return [{ kind: "read", ranges: [], rawPath: file[1]! }];

  return [
    {
      kind: "read",
      ranges: [
        { end: toInt(bounded[2] ?? bounded[3]), start: toInt(bounded[1]) ?? 1 },
      ],
      rawPath: file[1]!,
    },
  ];
}

/** `cat file` — but not `cat > file`, which the redirect matcher owns. */
function catMatches(segment: string): Found[] {
  const found: Found[] = [];
  for (const match of segment.matchAll(
    new RegExp(String.raw`\bcat\s+(?:-\w+\s+)*` + PATH, "g"),
  )) {
    found.push({ kind: "read", ranges: [], rawPath: match[1]! });
  }
  return found;
}

/**
 * `grep` / `rg` naming a file operand.
 *
 * Quoted runs are removed first: a pattern like `"from './x.ts'"` is not a file
 * the command read, and it is common enough in this corpus to matter. A search
 * over a directory yields nothing here, correctly — no single file was read.
 */
function grepMatches(segment: string): Found[] {
  if (!/\b(?:grep|rg|ripgrep)\b/.test(segment)) return [];

  const found: Found[] = [];
  for (const match of unquote(segment).matchAll(path("g"))) {
    found.push({ kind: "read", ranges: [], rawPath: match[1]! });
  }
  return found;
}

/** `> file`, `>> file` and `tee file`. */
function writeMatches(segment: string): Found[] {
  const found: Found[] = [];

  for (const match of segment.matchAll(
    new RegExp(String.raw`(?<![0-9<>])>>?\s*` + PATH, "g"),
  )) {
    found.push({ kind: "write", ranges: [], rawPath: match[1]! });
  }

  for (const match of segment.matchAll(
    new RegExp(String.raw`\btee\s+(?:-a\s+)?` + PATH, "g"),
  )) {
    found.push({ kind: "write", ranges: [], rawPath: match[1]! });
  }

  return found;
}

const MATCHERS = [
  sedMatches,
  headMatches,
  tailMatches,
  awkMatches,
  catMatches,
  grepMatches,
  writeMatches,
];

const CD = /^cd\s+(?:-{1,2}\s+)?("[^"]*"|'[^']*'|[^\s;&|]+)/;

const rangeKey = (ranges: readonly LineRange[]) =>
  ranges.map((range) => `${range.start}-${range.end ?? "*"}`).join(",");

/**
 * Every file a shell command read or wrote, in the order the command implies.
 *
 * Paths are returned already joined onto whatever `cd` was in effect, so a
 * caller resolves them against the agent's cwd exactly as it would a typed
 * tool's `path` argument — the parser's cwd tracking is relative to that same
 * starting point.
 */
export function parseBashAccesses(command: string): RawAccess[] {
  const accesses: RawAccess[] = [];
  const seen = new Set<string>();
  let cwd = ".";

  for (const segment of segments(stripHeredocs(command))) {
    const cd = CD.exec(segment);
    if (cd) {
      const target = cd[1]!.replace(/^["']|["']$/g, "");
      cwd = isAbsolute(target) ? normalize(target) : normalize(join(cwd, target));
      continue;
    }

    for (const matcher of MATCHERS) {
      for (const found of matcher(segment)) {
        const resolved = isAbsolute(found.rawPath)
          ? normalize(found.rawPath)
          : normalize(join(cwd, found.rawPath));

        const key = `${found.kind}:${resolved}:${rangeKey(found.ranges)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        accesses.push({
          confidence: "inferred",
          kind: found.kind,
          ranges: found.ranges,
          rawPath: resolved,
          tool: "bash",
        });

        if (accesses.length >= MAX_ACCESSES_PER_COMMAND) return accesses;
      }
    }
  }

  return accesses;
}
