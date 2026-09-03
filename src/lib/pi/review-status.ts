/**
 * What changed in a working copy, and what got committed while a turn ran.
 *
 * The reason this reads git rather than watching the agent: Semla already
 * observes `edit` and `write` tool calls to attach projects to a session
 * (src/lib/pi/session-project-attach.ts), and that observation has a
 * documented gap — writes made through `bash`, so `sed -i`, `mv`, `git
 * commit`, or generated build output, carry no typed path and are not seen.
 * A review surface built on it would show an empty panel after a turn that
 * changed a dozen files. `git status` sees every change however it was made,
 * so it is the source of truth here and tool observation stays what it is.
 *
 * Same shape as src/lib/pi/git-status.ts: pure parsers exported for tests,
 * readers that shell out beside them, and the types in a node-free module the
 * client can import.
 */

import { git, gitRaw, gitResult } from "@/lib/pi/git";
import {
  CHANGED_FILE_CAP,
  type ChangedFile,
  type ChangeStatus,
  type TurnCommit,
} from "@/lib/review-types";

/** A tree of any size should not outlive the operator's patience. */
const STATUS_TIMEOUT_MS = 30_000;

/** Porcelain pairs that mean a merge left the file conflicted. */
const UNMERGED = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

const CODE_STATUS: Record<string, ChangeStatus> = {
  A: "added",
  C: "copied",
  D: "deleted",
  M: "modified",
  R: "renamed",
  T: "type-changed",
};

/**
 * One word for a porcelain pair.
 *
 * The worktree column wins when both are set, because it describes the file as
 * it is on disk now — which is what the editor is about to show. `MM` is a
 * file staged and then modified again, and calling that "modified" is right
 * either way; `AM`, a new file staged then edited, is more usefully "added"
 * than "modified", so a worktree `M` defers to an index `A`.
 */
export function statusFromCodes(index: string, worktree: string): ChangeStatus {
  const pair = `${index}${worktree}`;
  if (pair === "??") return "untracked";
  if (UNMERGED.has(pair)) return "unmerged";
  if (index === "A" && worktree === "M") return "added";

  const fromWorktree = worktree !== " " ? CODE_STATUS[worktree] : undefined;
  const fromIndex = index !== " " ? CODE_STATUS[index] : undefined;
  return fromWorktree ?? fromIndex ?? "modified";
}

/**
 * Parse `git status --porcelain=v1 -z`.
 *
 * `-z` is not a detail. Without it git quotes any path with a space or a
 * non-ASCII byte and escapes it in octal — `"\303\274nicode.txt"` — and every
 * hand-rolled unquoter for that format is wrong in some case. With `-z` the
 * bytes arrive raw and the record separator cannot occur in a path.
 *
 * The trap it introduces instead: a rename entry spends **two** NUL-terminated
 * fields, and in `-z` the new path comes first with the original second. The
 * human-readable format prints `R old -> new`, the opposite order. Reading the
 * documentation for one and testing against the other produces a parser that
 * reports every rename backwards.
 */
export function parsePorcelain(output: string): ChangedFile[] {
  const fields = output.split("\0").filter((field) => field !== "");
  const files: ChangedFile[] = [];

  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    // "XY path" — two status codes, a separator, then the rest.
    if (field.length < 4) continue;

    const indexCode = field[0];
    const worktreeCode = field[1];
    const path = field.slice(3);
    const status = statusFromCodes(indexCode, worktreeCode);

    let oldPath: string | null = null;
    if (indexCode === "R" || indexCode === "C") {
      // The very next field, consumed here so it is not read as an entry.
      oldPath = fields[i + 1] ?? null;
      i += 1;
    }

    // An untracked file is outside the index entirely, so neither column
    // describes it — but a commit will not include it until it is added, and
    // for the operator that is exactly what "unstaged" means.
    const untracked = status === "untracked";

    files.push({
      indexCode,
      oldPath,
      path,
      staged: !untracked && indexCode !== " ",
      status,
      unstaged: untracked || worktreeCode !== " ",
      worktreeCode,
    });
  }

  return files;
}

/**
 * Every change in the working copy, capped.
 *
 * `--untracked-files=all` rather than the default `normal`: normal collapses an
 * untracked directory to one entry, and "the agent created src/lib/review/"
 * is not something an operator can review. Ignored files stay out — a review
 * surface listing node_modules is useless.
 */
export async function readChangedFiles(
  projectPath: string,
  cap: number = CHANGED_FILE_CAP,
): Promise<{ files: ChangedFile[]; omitted: number }> {
  // gitRaw, not git: porcelain's first column is a space when the index is
  // clean, and a trimmed " D gone.txt" becomes "D gone.txt" — every field
  // shifts by one and the first entry is reported with a truncated path.
  const output = await gitRaw(
    projectPath,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { timeout: STATUS_TIMEOUT_MS },
  );

  if (output === null) return { files: [], omitted: 0 };

  const all = parsePorcelain(output);
  return { files: all.slice(0, cap), omitted: Math.max(0, all.length - cap) };
}

/** HEAD's full sha, or null in a repository with no commits yet. */
export async function readHeadSha(projectPath: string): Promise<string | null> {
  return git(projectPath, ["rev-parse", "HEAD"]);
}

const RECORD = "\x1e";
const UNIT = "\x1f";

/** Parse the one-subprocess `git log` record format used below. */
export function parseTurnCommits(output: string): TurnCommit[] {
  return output
    .split(RECORD)
    .filter((record) => record.trim() !== "")
    .map((record) => {
      const [meta, ...rest] = record.split("\n");
      const [sha, shortSha, subject, author, at] = meta.split(UNIT);
      // --name-only prints a blank line, then one path per line.
      const fileCount = rest.filter((line) => line.trim() !== "").length;
      return {
        at: at ?? "",
        author: author ?? "",
        fileCount,
        sha: sha ?? "",
        shortSha: shortSha ?? "",
        subject: subject ?? "",
      };
    })
    .filter((commit) => commit.sha !== "");
}

/**
 * Commits between where the turn started and HEAD, newest first.
 *
 * Nothing forbids the agent committing — it has `bash`, and the system prompt
 * says nothing about git — so these exist and are invisible today. Reading
 * them is a fact about the repository, which is why this is preferred over a
 * prompt rule asking the agent not to commit: a rule is a request, and a model
 * that commits anyway produces exactly the silent gap the rule was meant to
 * close.
 *
 * No start sha means no range, and the honest answer is none rather than a
 * guess at where the turn began.
 */
export async function readTurnCommits(
  projectPath: string,
  startSha: string | null,
): Promise<TurnCommit[]> {
  if (!startSha) return [];

  // Refuse a range that is not one. A start sha from a session whose branch
  // has since been rebased or reset is not an ancestor of HEAD, and
  // `start..HEAD` would then quietly describe a different set of commits.
  // gitResult, not git: `--is-ancestor` answers with its exit code and prints
  // nothing at all, and `git` collapses empty stdout to null exactly as it
  // does a failure — so every range would read as "not an ancestor".
  const ancestor = await gitResult(projectPath, [
    "merge-base",
    "--is-ancestor",
    startSha,
    "HEAD",
  ]);
  if (!ancestor.ok) return [];

  const output = await git(
    projectPath,
    [
      "log",
      `--format=${RECORD}%H${UNIT}%h${UNIT}%s${UNIT}%an${UNIT}%aI`,
      "--name-only",
      `${startSha}..HEAD`,
    ],
    { timeout: STATUS_TIMEOUT_MS },
  );

  return output === null ? [] : parseTurnCommits(output);
}
