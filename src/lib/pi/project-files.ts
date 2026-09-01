/**
 * Every file in one project, as fast as that project allows.
 *
 * Walking the filesystem is the general answer and much the slowest one. A
 * workspace here holds around a million files across fifty repositories, six of
 * them Kibana checkouts of ~120,000 files each; a directory walk of one of those
 * costs seconds, and a budget large enough to finish it is a budget large enough
 * to stall the request.
 *
 * Git already has the answer. `git ls-files` reads that same checkout in about
 * 0.2s — it consults the index rather than the disk — and it applies
 * `.gitignore` for free, so build output and dependency trees never enter the
 * results in the first place instead of being filtered out by a hand-kept list
 * of directory names. Only the handful of directories that are not repositories
 * fall back to walking.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { walkFiles, type WalkResult } from "@/lib/pi/file-walk";

/**
 * Called with each file's path *relative to the project directory*, and its
 * basename.
 *
 * Relative rather than absolute because that is what git already returns, and
 * the caller only wants to prefix it with the project's name. Handing back an
 * absolute path meant joining a string onto every one of a million paths and
 * then calling `path.relative` to undo it — the single largest cost in a
 * workspace-wide search, spent entirely on getting back where we started.
 */
export type OnFile = (relativePath: string, name: string) => void;

export type ListOptions = {
  /** Maximum paths to take from this project before giving up on it. */
  budget: number;
  /** Milliseconds before the subprocess is abandoned. */
  timeoutMs?: number;
};

/** A git checkout, whether a clone or a linked worktree (where .git is a file). */
export const isGitRepository = (dir: string) => existsSync(join(dir, ".git"));

/**
 * Stream `git ls-files` for `dir`, calling `onFile` per path.
 *
 * Tracked files plus untracked ones git is not ignoring: a file written a minute
 * ago and not yet committed is still a file in the project, and omitting it
 * would make the browser quietly wrong about new work.
 *
 * Streamed rather than buffered. One large repository is several megabytes of
 * path text, and the caller keeps only the matches — there is no reason for the
 * whole listing to exist in memory at once.
 */
function gitListFiles(
  dir: string,
  onFile: OnFile,
  { budget, timeoutMs = 10_000 }: ListOptions,
): Promise<WalkResult> {
  return new Promise((resolve) => {
    const child = spawn(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: dir, stdio: ["ignore", "pipe", "ignore"] },
    );

    let examined = 0;
    let complete = true;
    let pending = "";
    let settled = false;

    const finish = (walkComplete: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve({ complete: walkComplete, examined });
    };

    const timer = setTimeout(() => finish(false), timeoutMs);

    const emit = (relPath: string) => {
      if (!relPath) return;
      examined++;
      onFile(relPath, relPath.slice(relPath.lastIndexOf("/") + 1));
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (settled) return;

      const parts = (pending + chunk).split("\0");
      // The final piece is whatever came before the next NUL arrives.
      pending = parts.pop() ?? "";

      for (const part of parts) {
        if (examined >= budget) {
          complete = false;
          finish(false);
          return;
        }
        emit(part);
      }
    });

    // A repository git cannot read is reported as an empty project rather than
    // an error: the rest of the workspace is still a useful answer.
    child.on("error", () => finish(true));
    child.on("close", () => {
      if (!settled && pending && examined < budget) emit(pending);
      finish(complete);
    });
  });
}

/** Every file in `dir`, via git when it is a repository and a walk when not. */
export function listProjectFiles(
  dir: string,
  onFile: OnFile,
  options: ListOptions,
): Promise<WalkResult> {
  if (isGitRepository(dir)) return gitListFiles(dir, onFile, options);

  // The walker reports absolute paths. Everything it finds is under `dir`, so
  // trimming the prefix is a slice rather than another path computation.
  const offset = dir.endsWith("/") ? dir.length : dir.length + 1;
  return walkFiles(dir, (absolutePath, name) => onFile(absolutePath.slice(offset), name), {
    budget: options.budget,
  });
}

/** Map `items` concurrently, at most `limit` at a time. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}
