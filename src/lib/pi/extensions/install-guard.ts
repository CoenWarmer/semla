/**
 * Stop the agent installing things nobody agreed to.
 *
 * `npx some-package` downloads and runs it when it is not already present, so a
 * single tool call can pull arbitrary code onto the machine and execute it —
 * the same for `npm install <pkg>` and its equivalents. Nothing in the agent
 * loop distinguishes that from running a local binary, and the transcript reads
 * identically either way.
 *
 * Enforced rather than requested. Prompt guidance has been tried repeatedly in
 * this codebase and lost every time it competed with a more specific
 * instruction; `tool_call` can refuse the call outright, and the reason goes
 * back to the agent so it can ask instead of guessing.
 *
 * The bar is "would this fetch something new", not "does this mention npm".
 * `npx tsc`, `npx vitest` and `npx eslint` run constantly here and resolve to
 * binaries already in node_modules, so blocking them would make the guard the
 * problem.
 */

/** Package managers whose add-a-dependency form fetches from a registry. */
const ADD_COMMANDS: ReadonlyArray<{ tool: string; verbs: readonly string[] }> = [
  { tool: "npm", verbs: ["install", "i", "add"] },
  { tool: "pnpm", verbs: ["install", "i", "add"] },
  { tool: "yarn", verbs: ["add"] },
  { tool: "bun", verbs: ["add", "install"] },
  { tool: "pip", verbs: ["install"] },
  { tool: "pip3", verbs: ["install"] },
  { tool: "gem", verbs: ["install"] },
  { tool: "cargo", verbs: ["add", "install"] },
  { tool: "go", verbs: ["get", "install"] },
  { tool: "brew", verbs: ["install"] },
];

export interface GuardVerdict {
  blocked: boolean;
  reason?: string;
}

const ALLOWED: GuardVerdict = { blocked: false };

const refuse = (what: string): GuardVerdict => ({
  blocked: true,
  reason:
    `Blocked: ${what} would install something that is not already present. ` +
    "Ask the user to confirm first — use the ask_user tool, naming the package " +
    "and why it is needed. If the command only runs a binary this project " +
    "already depends on, run it directly instead of through a package manager.",
});

/** Split a command line into the individual commands it will actually run. */
export function splitCommands(command: string): string[] {
  return command
    .split(/&&|\|\||;|\n|\|/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Flags whose value is a separate token, which would otherwise read as a
 * package name. `npm install --prefix .pi/npm` is this repo's own postinstall.
 */
const VALUE_FLAGS = new Set([
  "--prefix",
  "--registry",
  "--workspace",
  "-w",
  "--cache",
  "--userconfig",
  "--globalconfig",
  "--target",
  "-C",
]);

/** Positional arguments, with flags and the values they consume removed. */
export function positionalArgs(args: string[]): string[] {
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (VALUE_FLAGS.has(arg)) {
      i += 1; // its value is not a package
      continue;
    }
    if (arg.startsWith("-")) continue;
    positional.push(arg);
  }
  return positional;
}

const tokens = (segment: string): string[] =>
  segment.split(/\s+/).filter((token) => token.length > 0);

/**
 * Decide whether a bash command would fetch a package.
 *
 * `isInstalledBinary` answers whether an npx target already exists locally;
 * only that case is safe to wave through, since npx silently downloads
 * anything it cannot resolve.
 */
export function inspectCommand(
  command: string,
  isInstalledBinary: (name: string) => boolean,
): GuardVerdict {
  for (const segment of splitCommands(command)) {
    const parts = tokens(segment);
    if (parts.length === 0) continue;

    // Strip env assignments: FOO=bar npx thing
    let index = 0;
    while (index < parts.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[index]!)) {
      index += 1;
    }

    const tool = parts[index];
    if (!tool) continue;
    const args = parts.slice(index + 1).filter((arg) => arg !== "--");

    if (tool === "npx" || tool === "pnpx" || tool === "bunx") {
      // --yes exists to skip the install prompt, which is the whole concern.
      if (args.some((arg) => arg === "-y" || arg === "--yes")) {
        return refuse(`\`${segment}\``);
      }
      const target = positionalArgs(args)[0];
      if (target && !isInstalledBinary(target)) {
        return refuse(`\`${segment}\` (${target} is not installed)`);
      }
      continue;
    }

    const known = ADD_COMMANDS.find((entry) => entry.tool === tool);
    if (!known) continue;

    const positional = positionalArgs(args);
    const verb = positional[0];
    if (!verb || !known.verbs.includes(verb)) continue;

    // A bare `npm install` restores what package.json already declares, which
    // is not the agent choosing to add anything. Neither is one aimed at
    // another directory with --prefix.
    if (positional.length === 1) continue;

    return refuse(`\`${segment}\``);
  }

  return ALLOWED;
}
