/**
 * A cached `ts.Program` for the project a map is being built from.
 *
 * Building a program is the expensive part of resolving a call graph — a few
 * seconds for a repository this size — and the panel asks for one every time a
 * node is expanded. It is cached, but only briefly: the agent edits files while
 * the user is looking at the map, and a program is a snapshot. A map drawn from
 * a stale snapshot is exactly the kind of confidently wrong artefact this
 * feature exists to avoid, so the cache trades a rebuild for freshness rather
 * than the other way round.
 *
 * The tsconfig's own mtime is checked too, because changing `include` or `paths`
 * changes which files exist as far as the checker is concerned, and that is not
 * something a time-based expiry would catch quickly enough to be obvious.
 */

import { statSync } from "node:fs";
import { dirname, join } from "node:path";

import ts from "typescript";

/**
 * How long a program may be reused. Short enough that an edit made during a
 * conversation shows up on the next question about it.
 */
export const PROGRAM_TTL_MS = 30_000;

export type ProjectProgram = {
  program: ts.Program;
  checker: ts.TypeChecker;
  /** Directory holding the tsconfig, which paths are reported relative to. */
  projectRoot: string;
  configPath: string;
};

type CacheEntry = ProjectProgram & { builtAt: number; configMtimeMs: number };

const cache = new Map<string, CacheEntry>();

/** Walk up from `from` looking for the nearest tsconfig.json. */
export function findTsConfig(from: string): string | null {
  let dir = from;

  for (;;) {
    const candidate = join(dir, "tsconfig.json");
    if (ts.sys.fileExists(candidate)) return candidate;

    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const mtimeOf = (path: string): number => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
};

function build(configPath: string): ProjectProgram {
  const projectRoot = dirname(configPath);
  const config = ts.readConfigFile(configPath, (path) => ts.sys.readFile(path));

  if (config.error) {
    throw new Error(
      `Cannot read ${configPath}: ${ts.flattenDiagnosticMessageText(config.error.messageText, " ")}`,
    );
  }

  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    projectRoot,
  );

  // Diagnostics here are configuration problems, not type errors. Type errors
  // are irrelevant to a call graph — a project that does not compile still has
  // calls worth drawing — so only the config is treated as fatal.
  if (parsed.errors.length > 0) {
    const [first] = parsed.errors;
    throw new Error(
      `Cannot parse ${configPath}: ${ts.flattenDiagnosticMessageText(first.messageText, " ")}`,
    );
  }

  const program = ts.createProgram({
    options: parsed.options,
    rootNames: parsed.fileNames,
  });

  return {
    checker: program.getTypeChecker(),
    configPath,
    program,
    projectRoot,
  };
}

/**
 * Get a program for the project containing `from`, building one if the cached
 * copy is missing, expired, or built against a since-modified tsconfig.
 */
export function getProjectProgram(
  from: string,
  now: number = Date.now(),
): ProjectProgram {
  const configPath = findTsConfig(from);

  if (!configPath) {
    throw new Error(
      `No tsconfig.json found at or above ${from}. A code map needs one to know ` +
        "which files belong to the project.",
    );
  }

  const configMtimeMs = mtimeOf(configPath);
  const cached = cache.get(configPath);

  if (
    cached &&
    cached.configMtimeMs === configMtimeMs &&
    now - cached.builtAt < PROGRAM_TTL_MS
  ) {
    return cached;
  }

  const built = build(configPath);
  cache.set(configPath, { ...built, builtAt: now, configMtimeMs });
  return built;
}

/** Drop cached programs. Exported for tests and for an explicit refresh. */
export function clearProgramCache(): void {
  cache.clear();
}
