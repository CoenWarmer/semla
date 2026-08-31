import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitOptions {
  /** Milliseconds before the subprocess is killed. */
  timeout?: number;
  /** Talks to a remote: refuse every prompt so it can never hang waiting. */
  network?: boolean;
}

/**
 * A command that reaches the network must never stop to ask for anything.
 * Without these, a missing SSH key or an expired credential turns a fetch into
 * a process blocked on a prompt nobody can see or answer, and the timeout is
 * the only thing that ends it.
 */
const NON_INTERACTIVE_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",
  SSH_ASKPASS: "",
  GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=5",
};

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
export async function git(
  cwd: string,
  args: string[],
  { timeout = 2000, network = false }: GitOptions = {},
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      timeout,
      env: network ? { ...process.env, ...NON_INTERACTIVE_ENV } : process.env,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
