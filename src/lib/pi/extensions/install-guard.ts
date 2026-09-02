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

/**
 * Shell verbs that create or change files. A command mentioning a vault is
 * only a problem if it is going to write to one; reading is how anyone
 * inspects the wiki.
 */
const WRITE_VERBS = ["mkdir", "touch", "cp", "mv", "rm", "tee", "rsync"] as const;

const WRITE_REDIRECT = />>?\s*\S/;

/** Ways an agent has actually reached the wiki's internals from a shell. */
const WIKI_INTERNALS = /pi-llm-wiki|captureText|bootstrapVault|ensureVaultStructure/;

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
 * package name. A prefixed install like `npm install --prefix <dir>` is how
 * this repo installs its own side trees, so the guard must not read one as the
 * agent trying to add a dependency.
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
/**
 * Refuse to build a wiki vault by hand.
 *
 * A subagent without wiki tools did not stop — it reproduced them, calling the
 * package's own captureText from a shell and resolving the vault path itself.
 * That created a `.llm-wiki` inside the repo being oriented, and pi-llm-wiki
 * prefers a vault in the working directory over WIKI_HOME from then on, so
 * every later capture went there. Three repos ended up with one, and a whole
 * run's work landed in a directory nobody was reading.
 *
 * Reads are left alone: inspecting a vault is how anyone works out what
 * happened, including this diagnosis.
 */
export function inspectVaultWrite(segment: string, wikiHome: string): GuardVerdict {
  const touchesVault = segment.includes(".llm-wiki") || WIKI_INTERNALS.test(segment);
  if (!touchesVault) return ALLOWED;

  // A path under the real vault is the wiki's own business.
  if (segment.includes(wikiHome)) return ALLOWED;

  const writes =
    WRITE_REDIRECT.test(segment) ||
    WRITE_VERBS.some((verb) => new RegExp(`(^|\\s)${verb}\\s`).test(segment));
  if (!writes) return ALLOWED;

  return {
    blocked: true,
    reason:
      `Blocked: this writes a wiki vault outside ${wikiHome}. A vault inside a ` +
      "repository takes precedence over WIKI_HOME from then on, so everything " +
      "captured afterwards goes there instead. Use the wiki tools; if they are " +
      "missing, say so rather than reproducing them — a hand-built vault in the " +
      "wrong place is worse than no capture.",
  };
}

export function inspectCommand(
  command: string,
  isInstalledBinary: (name: string) => boolean,
  wikiHome?: string,
): GuardVerdict {
  for (const segment of splitCommands(command)) {
    if (wikiHome) {
      const vault = inspectVaultWrite(segment, wikiHome);
      if (vault.blocked) return vault;
    }

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

/**
 * Refuse a bootstrap that would build the vault somewhere other than WIKI_HOME.
 *
 * `wiki_bootstrap` resolves its target as `params.root ?? ctx.cwd ??
 * process.cwd()` and never consults WIKI_HOME. A subagent's cwd is the
 * workspace root — the directory that *contains* the repos — so bootstrapping
 * an empty wiki created a vault at `/Users/coen/Dev/.llm-wiki`, and a vault
 * found at cwd wins over WIKI_HOME from then on. One run split in two:
 * fourteen packets in the new vault, synthesis still reading the old one, and
 * the agent reporting the wrong path as WIKI_HOME in its own transcript.
 *
 * The vault is created for it at extension load, so a bootstrap is never
 * needed. This refuses the one that would undo that, and says where to look
 * instead — a blocked call that leaves the agent guessing gets worked around.
 */
export function inspectBootstrap(root: unknown, wikiHome: string): GuardVerdict {
  if (typeof root === "string" && root.trim() !== "") {
    const target = root.trim().replace(/\/+$/, "");
    if (target === wikiHome.replace(/\/+$/, "")) return ALLOWED;
    return {
      blocked: true,
      reason:
        `Blocked: this would build a wiki vault at ${target}, not ${wikiHome}. ` +
        "A vault found in the working directory takes precedence over WIKI_HOME " +
        `from then on, so every later capture would go there. The vault at ${wikiHome} ` +
        "already exists — use it.",
    };
  }

  // No root given is the dangerous form: it silently means cwd, which is the
  // workspace root rather than any repo.
  return {
    blocked: true,
    reason:
      `Blocked: wiki_bootstrap with no \`root\` builds the vault in the working ` +
      `directory, which is the workspace root, not ${wikiHome}. The vault at ` +
      `${wikiHome} already exists and is the one Semla reads — check it with ` +
      "wiki_status rather than creating another.",
  };
}
