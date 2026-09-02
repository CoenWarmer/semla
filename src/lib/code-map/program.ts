/**
 * A cached TypeScript project for the code a map is being built from.
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
 *
 * **Under TypeScript 7 a program is a subprocess, not an object.** `new API()`
 * spawns the native compiler and every node, symbol and type reached from here
 * is a handle into it. That makes disposal load-bearing in a way it never was
 * with TS 5: an entry dropped from this cache without `close()` leaks a running
 * compiler, and the panel rebuilds often. Eviction therefore goes through
 * `release`, and every path that removes an entry uses it.
 */

import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { API, type Checker, type Program, type Project } from "typescript/unstable/sync";

/**
 * How long a program may be reused. Short enough that an edit made during a
 * conversation shows up on the next question about it.
 */
export const PROGRAM_TTL_MS = 30_000;

export type ProjectProgram = {
  program: Program;
  checker: Checker;
  /**
   * The project the program belongs to. Callers need it to turn the
   * `NodeHandle`s on a symbol back into nodes — a handle is only meaningful
   * within the project that produced it.
   */
  project: Project;
  /** Directory holding the tsconfig, which paths are reported relative to. */
  projectRoot: string;
  configPath: string;
};

type CacheEntry = ProjectProgram & {
  builtAt: number;
  configMtimeMs: number;
  /** Shuts down the compiler subprocess behind this entry. */
  release: () => void;
};

const cache = new Map<string, CacheEntry>();

/** Walk up from `from` looking for the nearest tsconfig.json. */
export function findTsConfig(from: string): string | null {
  let dir = from;

  for (;;) {
    const candidate = join(dir, "tsconfig.json");
    if (existsSync(candidate)) return candidate;

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

function build(configPath: string): Omit<CacheEntry, "builtAt" | "configMtimeMs"> {
  const projectRoot = dirname(configPath);
  const api = new API({ cwd: projectRoot });

  // Anything past this point owns a subprocess, so a throw has to take it down
  // with it or the failure leaks a compiler per attempt.
  try {
    // Config problems are fatal; type errors are not. A project that does not
    // compile still has calls worth drawing, so only the config is checked.
    api.parseConfigFile(configPath);

    const snapshot = api.updateSnapshot({ openProjects: [configPath] });
    const project = snapshot.getProject(configPath);

    if (!project) {
      throw new Error(
        `${configPath} parsed but produced no project. It may define no files ` +
          "— check its `include` and `files` patterns.",
      );
    }

    return {
      checker: project.checker,
      configPath,
      program: project.program,
      project,
      projectRoot,
      release: () => {
        snapshot.dispose();
        api.close();
      },
    };
  } catch (error) {
    api.close();
    throw error instanceof Error
      ? new Error(`Cannot load ${configPath}: ${error.message}`)
      : error;
  }
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

  // Built before the stale entry is released, so a failed rebuild leaves the
  // cache as it was rather than emptied.
  const built = build(configPath);
  cached?.release();
  cache.set(configPath, { ...built, builtAt: now, configMtimeMs });
  return built;
}

/**
 * Drop cached programs, shutting down their compilers.
 *
 * Exported for tests and for an explicit refresh. Not optional under TS 7: the
 * subprocesses outlive the cache entries otherwise.
 */
export function clearProgramCache(): void {
  for (const entry of cache.values()) entry.release();
  cache.clear();
}
