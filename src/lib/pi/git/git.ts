import { execFile, spawn } from "node:child_process";
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

/**
 * Run a git command and return stdout exactly as git wrote it, or null.
 *
 * `git` and `gitResult` both trim, which is right for the single-value reads
 * they were written for and wrong for a format whose first character carries
 * meaning. `git status --porcelain` is one: its first column is a space
 * whenever the index matches HEAD, so trimming turns " D gone.txt" into
 * "D gone.txt", every field shifts by one, and the first entry comes back with
 * a truncated path and its two status codes inverted. That bug is invisible in
 * a parser test — the fixture never went through here — and showed up only
 * against a real repository.
 *
 * Failure still collapses to null, for the reasons `git` gives.
 */
export async function gitRaw(
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
    return stdout;
  } catch {
    return null;
  }
}

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Run a git command and keep the outcome, including why it failed.
 *
 * `git` above collapses every failure to null, which is right for reads that
 * decorate a UI. An action the user pressed a button for is different: when a
 * merge refuses because the tree is dirty, the reason *is* the useful part.
 */
export async function gitResult(
  cwd: string,
  args: string[],
  { timeout = 10_000, network = false }: GitOptions = {},
): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      timeout,
      env: network ? { ...process.env, ...NON_INTERACTIVE_ENV } : process.env,
    });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    const shell = error as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: (shell.stdout ?? "").trim(),
      stderr: (shell.stderr ?? shell.message ?? "git failed").trim(),
    };
  }
}

/**
 * Run a git command with something on its stdin, and keep the outcome.
 *
 * `execFile` has no way to supply stdin, so this is the one helper built on
 * `spawn`. It exists for `git apply`, which reads a patch from `-`.
 *
 * Writing the patch to a temporary file and passing the path would have reused
 * `gitResult` unchanged, and was rejected: a patch is the exact content of the
 * operator's staging decision, and putting it on disk means a crash can leave
 * it there, in a temp directory, readable. Piping it keeps it in memory for
 * the life of the subprocess.
 *
 * stderr is captured rather than inherited: `git apply`'s refusal is the
 * useful part, and it only ever writes it there.
 */
export async function gitInput(
  cwd: string,
  args: string[],
  input: string,
  { timeout = 10_000 }: Pick<GitOptions, "timeout"> = {},
): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: GitResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, stderr: "git timed out", stdout: "" });
    }, timeout);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));

    child.on("error", (error) => {
      clearTimeout(timer);
      finish({ ok: false, stderr: error.message, stdout: "" });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      finish({ ok: code === 0, stderr: stderr.trim(), stdout: stdout.trim() });
    });

    // A patch larger than the pipe buffer makes this write asynchronous, so
    // the error has to be handled or it surfaces as an unhandled EPIPE.
    child.stdin.on("error", () => {
      /* The close handler already reports why git rejected it. */
    });
    child.stdin.end(input);
  });
}
