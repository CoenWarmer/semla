/**
 * Reading a file's diff and parsing it into hunks.
 *
 * One hunk model serves two purposes, which is why this is not two modules:
 * the editor colours lines and characters from these hunks, and a commit
 * applies a patch rebuilt from a chosen subset of them. If the thing being
 * displayed and the thing being staged were parsed separately they could
 * disagree, and the operator would stage something other than what they read.
 *
 * `header` is kept verbatim for that reason. A patch built from a subset of
 * hunks needs the original `diff --git` preamble back unchanged; regenerating
 * it from parsed parts is the usual way a generated patch stops applying.
 */

import { gitResult } from "@/lib/pi/git";
import { changedSpans } from "@/lib/pi/review-char-spans";
import type { DiffLine, FileDiff, Hunk } from "@/lib/review-types";

/** A large file's diff is still worth waiting for; an unbounded one is not. */
const DIFF_TIMEOUT_MS = 30_000;

const NO_NEWLINE = "\\ No newline at end of file";

/** `@@ -12,7 +12,9 @@ function readGitStatus(` — counts are optional. */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/**
 * The path a `---` or `+++` line names, or null for /dev/null.
 *
 * Taken from these lines rather than from `diff --git a/x b/y`, because that
 * line is ambiguous when a path contains a space: `a/my file b/my file` has no
 * unique split point. The `---`/`+++` pair has exactly one prefix to strip.
 */
function pathFromMarker(line: string): string | null {
  const value = line.slice(4).trim();
  if (value === "/dev/null") return null;
  return value.startsWith("a/") || value.startsWith("b/")
    ? value.slice(2)
    : value;
}

/**
 * Pair each removed line with the added line that replaced it, and record
 * which characters differ.
 *
 * Pairing is positional within a run: the nth removed line against the nth
 * added line, for as many as both runs have. That is what a reader assumes
 * when they see a block replaced by a block, and it is stable — an LCS over
 * lines would sometimes pair the 1st with the 3rd and colour a line against
 * something that is not above it.
 *
 * A run with no counterpart gets no spans. Wholly new lines are already
 * coloured as new, and colouring every character of them adds nothing.
 */
function attachSpans(lines: DiffLine[]): void {
  let index = 0;

  while (index < lines.length) {
    if (lines[index].kind !== "removed") {
      index += 1;
      continue;
    }

    const removed: DiffLine[] = [];
    while (index < lines.length && lines[index].kind === "removed") {
      removed.push(lines[index]);
      index += 1;
    }

    const added: DiffLine[] = [];
    while (index < lines.length && lines[index].kind === "added") {
      added.push(lines[index]);
      index += 1;
    }

    const pairs = Math.min(removed.length, added.length);
    for (let i = 0; i < pairs; i += 1) {
      added[i].spans = changedSpans(removed[i].text, added[i].text);
      removed[i].spans = changedSpans(added[i].text, removed[i].text);
    }
  }
}

/** Read one hunk's body, stopping at the next hunk or the next file. */
function parseHunkLines(
  body: string[],
  oldStart: number,
  newStart: number,
): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldLine = oldStart;
  let newLine = newStart;

  for (const raw of body) {
    if (raw === NO_NEWLINE) {
      // Applies to the line just emitted, and must survive into any patch
      // built from this hunk or `git apply` rejects it.
      const last = lines[lines.length - 1];
      if (last) last.noNewline = true;
      continue;
    }

    const marker = raw[0] ?? " ";
    const text = raw.slice(1);

    if (marker === "+") {
      lines.push({
        kind: "added",
        newLine,
        noNewline: false,
        oldLine: null,
        spans: [],
        text,
      });
      newLine += 1;
    } else if (marker === "-") {
      lines.push({
        kind: "removed",
        newLine: null,
        noNewline: false,
        oldLine,
        spans: [],
        text,
      });
      oldLine += 1;
    } else {
      lines.push({
        kind: "context",
        newLine,
        noNewline: false,
        oldLine,
        spans: [],
        text,
      });
      oldLine += 1;
      newLine += 1;
    }
  }

  attachSpans(lines);
  return lines;
}

/**
 * Parse the output of `git diff` into one entry per file.
 *
 * Handles the three shapes that carry no hunks and are still real changes: a
 * binary file, a mode change on its own, and a rename with no edits. A parser
 * that only understands `@@` blocks drops all three, and the operator sees a
 * file that git says changed and the panel says did not.
 */
export function parseUnifiedDiff(output: string): FileDiff[] {
  const lines = output.split("\n");
  const files: FileDiff[] = [];

  let current: FileDiff | null = null;
  let hunk: Hunk | null = null;
  let hunkBody: string[] = [];
  let hunkStart: { newStart: number; oldStart: number } | null = null;

  const closeHunk = () => {
    if (current && hunk && hunkStart) {
      hunk.lines = parseHunkLines(hunkBody, hunkStart.oldStart, hunkStart.newStart);
      current.hunks.push(hunk);
    }
    hunk = null;
    hunkBody = [];
    hunkStart = null;
  };

  const closeFile = () => {
    closeHunk();
    if (current) {
      current.modeChangeOnly =
        current.hunks.length === 0 && !current.binary && current.header.includes("\nnew mode ");
      files.push(current);
    }
    current = null;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      closeFile();
      current = {
        binary: false,
        header: line,
        hunks: [],
        modeChangeOnly: false,
        oldPath: null,
        path: "",
      };
      continue;
    }

    if (!current) continue;

    if (hunk) {
      if (line.startsWith("@@")) {
        closeHunk();
      } else {
        // A trailing empty string from the final newline is not a diff line.
        if (line !== "") hunkBody.push(line);
        continue;
      }
    }

    const match = HUNK_HEADER.exec(line);
    if (match) {
      const oldStart = Number(match[1]);
      const newStart = Number(match[3]);
      hunkStart = { newStart, oldStart };
      hunk = {
        heading: match[5] ?? "",
        index: current.hunks.length,
        lines: [],
        newLines: match[4] === undefined ? 1 : Number(match[4]),
        newStart,
        oldLines: match[2] === undefined ? 1 : Number(match[2]),
        oldStart,
      };
      continue;
    }

    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      current.binary = true;
      current.header += `\n${line}`;
      continue;
    }

    if (line.startsWith("--- ")) {
      current.oldPath = pathFromMarker(line);
      current.header += `\n${line}`;
      continue;
    }

    if (line.startsWith("+++ ")) {
      const path = pathFromMarker(line);
      // A deletion has no post-image path; the file is the one `---` named.
      current.path = path ?? current.oldPath ?? "";
      current.header += `\n${line}`;
      continue;
    }

    if (line !== "") current.header += `\n${line}`;
  }

  closeFile();

  // A rename or mode change with no hunks never reached the `+++` branch.
  return files.map((file) => {
    if (file.path !== "") return file;
    const renameTo = /\nrename to (.+)/.exec(file.header)?.[1];
    const gitLine = /^diff --git a\/(.+) b\/(.+)$/.exec(file.header.split("\n")[0]);
    return {
      ...file,
      oldPath: file.oldPath ?? /\nrename from (.+)/.exec(file.header)?.[1] ?? null,
      path: renameTo ?? gitLine?.[2] ?? "",
    };
  });
}

/**
 * Which two versions of a file a diff is between.
 *
 * Three, not two, because the editor and the staging controls are asking
 * different questions. "What did this turn change" is the worktree against
 * HEAD and takes no notice of what happens to be staged; "what would this
 * commit include" is the index against HEAD. Deriving either from the other is
 * where a staging UI starts lying about what it is about to commit.
 */
export type DiffBase = "head" | "index" | "staged";

/**
 * A tracked file's diff.
 *
 * `-M` so a rename is reported as one, rather than as a delete and an add of a
 * file whose every line reads as changed.
 */
export async function readFileDiff(
  projectPath: string,
  relPath: string,
  base: DiffBase = "index",
): Promise<FileDiff | null> {
  const args = ["diff", "--no-color", "-U3", "-M"];
  if (base === "head") args.push("HEAD");
  if (base === "staged") args.push("--cached");
  args.push("--", relPath);

  const result = await gitResult(projectPath, args, { timeout: DIFF_TIMEOUT_MS });
  if (!result.ok && result.stdout === "") return null;

  return parseUnifiedDiff(result.stdout)[0] ?? null;
}

/**
 * An untracked file's diff, without touching the index.
 *
 * `git diff` says nothing about a file it does not track, and the usual answer
 * is `git add -N` to give it an intent-to-add entry. That writes to the index
 * during what the operator asked to be a read, and a review panel that mutates
 * the repository to render itself is the wrong shape.
 *
 * `--no-index` against /dev/null produces the same `new file mode` diff with no
 * side effects. It implies `--exit-code`, so a diff that exists exits 1 — hence
 * reading stdout regardless of `ok`.
 */
export async function readUntrackedDiff(
  projectPath: string,
  relPath: string,
): Promise<FileDiff | null> {
  const result = await gitResult(
    projectPath,
    ["diff", "--no-color", "-U3", "--no-index", "--", "/dev/null", relPath],
    { timeout: DIFF_TIMEOUT_MS },
  );

  if (result.stdout === "") return null;
  return parseUnifiedDiff(result.stdout)[0] ?? null;
}

/**
 * Every view of one file's change at once.
 *
 * `full` is what the editor colours: everything that happened to this file
 * since HEAD, whether or not it is staged, because that is what the operator
 * means by "what changed". `staged` and `unstaged` are what the staging
 * controls act on.
 *
 * An untracked file has no index entry and no HEAD version, so `full` and
 * `unstaged` are the same synthesized diff and `staged` is nothing. Staging it
 * means adding the file, which is why there is no hunk-level answer to give.
 */
export interface FileDiffSet {
  full: FileDiff | null;
  staged: FileDiff | null;
  unstaged: FileDiff | null;
  untracked: boolean;
}

export async function readFileDiffSet(
  projectPath: string,
  relPath: string,
  options: { untracked?: boolean } = {},
): Promise<FileDiffSet> {
  if (options.untracked) {
    const diff = await readUntrackedDiff(projectPath, relPath);
    return { full: diff, staged: null, unstaged: diff, untracked: true };
  }

  const [full, staged, unstaged] = await Promise.all([
    readFileDiff(projectPath, relPath, "head"),
    readFileDiff(projectPath, relPath, "staged"),
    readFileDiff(projectPath, relPath, "index"),
  ]);

  return { full, staged, unstaged, untracked: false };
}
