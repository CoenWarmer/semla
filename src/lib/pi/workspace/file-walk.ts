/**
 * A bounded recursive walk of the workspace, for the file browser's search.
 *
 * The workspace root holds every repository on the machine, so an unbounded
 * walk is a request that never returns: one `node_modules` is six figures of
 * files on its own. Two limits make this safe to call on a keystroke — a set of
 * directories never descended into, and a hard budget on entries examined.
 *
 * The budget is reported rather than enforced silently. A search that ran out
 * of budget has not searched the workspace, and the UI says so instead of
 * presenting a partial answer as a complete one.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Directories whose contents are never a useful search result: dependencies,
 * build output, and VCS internals. Dotted names are skipped separately.
 */
export const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "vendor",
  "target",
  "__pycache__",
]);

export type WalkOptions = {
  /** Absolute directories to leave out of this walk entirely. */
  skip?: ReadonlySet<string>;
  /** Maximum directory entries to examine before giving up. */
  budget: number;
};

export type WalkResult = {
  /** False when the budget ran out before the tree was exhausted. */
  complete: boolean;
  /** Entries examined, so a caller can spend one budget across two walks. */
  examined: number;
};

/**
 * Call `onFile` with the absolute path of every file under `root`.
 *
 * Iterative rather than recursive: the stack depth of a deep monorepo is not
 * worth risking, and an explicit stack makes the budget check one place.
 */
export async function walkFiles(
  root: string,
  onFile: (absolutePath: string, name: string) => void,
  { skip, budget }: WalkOptions,
): Promise<WalkResult> {
  const stack: string[] = [root];
  let examined = 0;

  while (stack.length > 0) {
    const dir = stack.pop()!;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // Unreadable directory — a permission error or a broken symlink. The rest
      // of the walk is still a useful answer.
      continue;
    }

    for (const entry of entries) {
      if (examined >= budget) return { complete: false, examined };
      examined++;

      if (entry.name.startsWith(".")) continue;
      const absolutePath = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        if (skip?.has(absolutePath)) continue;
        stack.push(absolutePath);
      } else if (entry.isFile()) {
        onFile(absolutePath, entry.name);
      }
    }
  }

  return { complete: true, examined };
}
