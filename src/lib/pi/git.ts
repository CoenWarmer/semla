import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Run a git command in `cwd` and return its trimmed stdout, or null.
 *
 * Every failure mode collapses to null on purpose: the directory may not be a
 * repository, the ref may not exist, the repo may have no commits, or git may
 * hang on a lock. Callers here are decorating a UI, so none of those deserve
 * to surface as an error — they just mean there is nothing to show.
 *
 * Always async. Its predecessor used execSync, which blocks the Node event
 * loop for the whole subprocess and stalled every other request behind it.
 */
export async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 2000,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
