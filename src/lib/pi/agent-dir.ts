/**
 * Semla's own pi agent directory, isolated from the one on the host.
 *
 * `getAgentDir()` in pi-coding-agent resolves to `~/.pi/agent` unless
 * PI_CODING_AGENT_DIR says otherwise, and every ModelRuntime resolves it
 * independently. So while Semla already pinned extensions, skills and packages
 * to its own paths, credentials and the model catalog still came from whatever
 * the developer had configured with the `pi` CLI — meaning a change to the
 * host's auth.json changed Semla's behaviour with no change to Semla.
 *
 * Pointing at an empty directory is not enough on its own: the catalog lives in
 * models-store.json, and without it `getAvailable()` returns nothing, the model
 * picker is empty and every session fails with "model is not available". So the
 * directory is seeded once from the host, and only ever once — after that the
 * two diverge, which is the point.
 *
 * Deliberately seeded with credentials and the catalog and nothing else.
 * Copying settings.json or npm/ across would re-inherit the host's installed
 * packages, which is the failure PI_AGENT_DIR was introduced to avoid: the
 * workflow extension loaded twice and the second copy failed on a tool-name
 * conflict.
 *
 * Lives outside the repository because auth.json holds real credentials and
 * `.pi/` is tracked in git — a Semla-owned directory inside the tree would put
 * secrets one `git add -A` away from being committed.
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Environment variable pi-coding-agent reads; note it is not PI_AGENT_DIR. */
export const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

export const PI_AGENT_DIR =
  process.env[PI_AGENT_DIR_ENV] ??
  process.env.PI_AGENT_DIR ??
  join(homedir(), ".semla", "agent");

/** Where the `pi` CLI keeps its configuration for this user. */
export const HOST_PI_AGENT_DIR = join(homedir(), ".pi", "agent");

/**
 * Files worth carrying over on first run: the credentials, and the model
 * catalog that would otherwise leave the runtime with no models at all.
 */
export const SEEDED_FILES = ["auth.json", "models-store.json"] as const;

export interface AgentDirIsolation {
  dir: string;
  /** Files copied from the host on this call; empty once the dir is populated. */
  seeded: string[];
}

/**
 * Point pi at Semla's agent directory, seeding it from the host if it is new.
 *
 * Must run before anything constructs a ModelRuntime — the env var is read at
 * call time, and several route handlers build one without going through
 * runtime-config. instrumentation.ts is what guarantees that ordering.
 */
export function isolatePiAgentDir(
  options: { dir?: string; hostDir?: string } = {},
): AgentDirIsolation {
  const dir = options.dir ?? PI_AGENT_DIR;
  const hostDir = options.hostDir ?? HOST_PI_AGENT_DIR;

  process.env[PI_AGENT_DIR_ENV] = dir;
  mkdirSync(dir, { recursive: true });

  const seeded: string[] = [];
  for (const file of SEEDED_FILES) {
    const target = join(dir, file);
    const source = join(hostDir, file);
    // Never overwrite: once seeded, the host's copy no longer has any say.
    if (existsSync(target) || !existsSync(source)) continue;
    try {
      copyFileSync(source, target);
      seeded.push(file);
    } catch {
      // A missing credential surfaces as "no models" in the picker, which is a
      // better failure than refusing to start the server.
    }
  }

  return { dir, seeded };
}
