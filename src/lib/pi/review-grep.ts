/**
 * Searching what is *inside* the files, not just their names.
 *
 * **ripgrep, with `git grep` behind it.** Both honour .gitignore, so both skip
 * node_modules and build output, and both see files the turn just created —
 * which are exactly the ones a reviewer is looking for. The difference is
 * speed, and it is not marginal: measured on this machine against kibana
 * (121,481 tracked files), `git grep` takes 5.0s and ripgrep 2.1s, with less
 * than half the system time. On a small repository both are instant (semla,
 * 643 files: 38ms), so this only matters for the case where it matters.
 *
 * ripgrep arrives as `@vscode/ripgrep`, which since 1.18 ships the binary as
 * per-platform optional dependencies rather than fetching it in a postinstall
 * script — so it needs no entry in this repository's `allowScripts` policy and
 * no network access at install beyond npm's own.
 *
 * The fallback is not ceremony. Optional dependencies are exactly the ones an
 * install can legitimately skip — an unsupported platform, or
 * `npm install --no-optional` — and when that happens `rgPath` names a file
 * that is not there. Falling back to `git grep` keeps the feature working at
 * a third of the speed instead of failing outright, and git is already a hard
 * dependency of every other route here.
 *
 * Every option below is either a bound or a safety property; none is a
 * preference. See the notes on each.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

import { rgPath } from "@vscode/ripgrep";

import { gitRaw } from "@/lib/pi/git";

const execFileAsync = promisify(execFile);

/** A repository-wide grep is fast, but not on a cold cache over a monorepo. */
const GREP_TIMEOUT_MS = 15_000;

/**
 * Below this a search is not worth running. One or two characters match
 * essentially every file and cost a full sweep to say so.
 */
export const MIN_QUERY_LENGTH = 3;

/** Total hits returned. The panel shows a list, not a report. */
export const MAX_RESULTS = 100;

/**
 * Hits per file, so one generated or vendored file cannot fill the whole
 * result set and hide matches everywhere else.
 */
const MAX_PER_FILE = 5;

export interface ContentMatch {
  /** Project-relative path, as git reports it. */
  path: string;
  /** One-based line number. */
  line: number;
  /** The matching line, trimmed of leading indentation for display. */
  text: string;
}

/**
 * Parse `git grep -z -n` output.
 *
 * `-z` puts a NUL between the path, the line number and the text; without it
 * the separator is a colon, and a path containing one — or a line of code
 * containing one, which is most lines of code — makes the fields ambiguous.
 * Records are still newline-terminated, and a matching line cannot itself
 * contain a newline, so splitting on it is safe.
 */
export function parseGrepOutput(output: string): ContentMatch[] {
  const matches: ContentMatch[] = [];

  for (const record of output.split("\n")) {
    if (record === "") continue;

    const first = record.indexOf("\0");
    const second = record.indexOf("\0", first + 1);
    if (first === -1 || second === -1) continue;

    const line = Number(record.slice(first + 1, second));
    if (!Number.isInteger(line)) continue;

    matches.push({
      line,
      path: record.slice(0, first),
      // Indentation is noise in a one-line preview and pushes the match off
      // the end of a narrow sidebar.
      text: record.slice(second + 1).trim(),
    });
  }

  return matches;
}

export interface GrepResult {
  matches: ContentMatch[];
  /** The cap stopped the list before the search ran out of hits. */
  truncated: boolean;
}

/**
 * Parse `rg --null --no-heading --line-number` output.
 *
 * A different shape from git grep's: ripgrep puts the NUL after the path only,
 * leaving `line:text` colon-separated. The line number is numeric and comes
 * first, so the split is still unambiguous — but assuming git grep's three
 * NUL-separated fields here would silently produce no matches at all.
 *
 * Paths come back `./`-prefixed because the search is rooted at the project
 * directory; the panel addresses files without it.
 */
export function parseRipgrepOutput(output: string): ContentMatch[] {
  const matches: ContentMatch[] = [];

  for (const record of output.split("\n")) {
    if (record === "") continue;

    const nul = record.indexOf("\0");
    if (nul === -1) continue;

    const rest = record.slice(nul + 1);
    const colon = rest.indexOf(":");
    if (colon === -1) continue;

    const line = Number(rest.slice(0, colon));
    if (!Number.isInteger(line)) continue;

    const path = record.slice(0, nul);
    matches.push({
      line,
      path: path.startsWith("./") ? path.slice(2) : path,
      text: rest.slice(colon + 1).trim(),
    });
  }

  return matches;
}

/** True when the platform binary this build needs was actually installed. */
export const ripgrepAvailable = (): boolean =>
  typeof rgPath === "string" && rgPath !== "" && existsSync(rgPath);

async function ripgrepSearch(
  projectPath: string,
  needle: string,
): Promise<ContentMatch[] | null> {
  try {
    const { stdout } = await execFileAsync(
      rgPath,
      [
        "--line-number",
        // Forced: with a single path argument ripgrep omits the filename, and
        // the parse would then have nothing to attribute a match to.
        "--with-filename",
        "--no-heading",
        "--null",
        "--fixed-strings",
        "--ignore-case",
        // Dotfiles are project files: .oxlintrc.json and .gitignore are things
        // a turn changes and a reviewer searches for. ripgrep skips them by
        // default, and descends into .git once they are enabled.
        "--hidden",
        "--glob=!.git",
        `--max-count=${MAX_PER_FILE}`,
        // Unreadable directories are not this feature's problem to report.
        "--no-messages",
        "-e",
        needle,
        "--",
        ".",
      ],
      { cwd: projectPath, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: GREP_TIMEOUT_MS },
    );
    return parseRipgrepOutput(stdout);
  } catch (error) {
    // Exit 1 is "no matches", which is an answer. Anything else — a missing
    // binary, a timeout — falls through to git grep.
    const failure = error as { code?: number | string; stdout?: string };
    if (failure.code === 1) return parseRipgrepOutput(failure.stdout ?? "");
    return null;
  }
}

/**
 * Lines in `projectPath` containing `query`.
 *
 * Literal, case-insensitive, and never a regular expression: this is a filter
 * box, and a query of `a.b(` should find `a.b(` rather than raising an error
 * or quietly matching something else.
 */
export async function grepProject(
  projectPath: string,
  query: string,
): Promise<GrepResult> {
  const needle = query.trim();
  if (needle.length < MIN_QUERY_LENGTH) return { matches: [], truncated: false };

  if (ripgrepAvailable()) {
    const viaRipgrep = await ripgrepSearch(projectPath, needle);
    if (viaRipgrep !== null) {
      return {
        matches: viaRipgrep.slice(0, MAX_RESULTS),
        truncated: viaRipgrep.length > MAX_RESULTS,
      };
    }
  }

  const output = await gitRaw(
    projectPath,
    [
      "grep",
      "-z",
      "--line-number",
      // Skip binary files rather than reporting "binary file matches".
      "-I",
      "--fixed-strings",
      "--ignore-case",
      "--untracked",
      `--max-count=${MAX_PER_FILE}`,
      // `-e` terminates option parsing for the pattern, so a query beginning
      // with a dash is a search term and not a flag git will reject.
      "-e",
      needle,
      // And this one stops any remaining argument being read as a path.
      "--",
    ],
    { timeout: GREP_TIMEOUT_MS },
  );

  // git grep exits non-zero when there are no matches, which gitRaw reports as
  // null. That is the common case, not a failure.
  if (output === null) return { matches: [], truncated: false };

  const all = parseGrepOutput(output);
  return {
    matches: all.slice(0, MAX_RESULTS),
    truncated: all.length > MAX_RESULTS,
  };
}
