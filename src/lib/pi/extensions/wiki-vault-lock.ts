/**
 * Cross-process mutual exclusion for vault writes.
 *
 * Two orient sessions sharing one vault contend on operations pi-llm-wiki
 * performs as read-then-write with no locking of its own:
 *
 *  - Source ids. `nextSequentialId` lists raw/sources, takes the highest and
 *    adds one. Two captures that both list before either writes get the *same*
 *    id, and the second packet overwrites the first. Nothing errors; a source
 *    just disappears.
 *  - Metadata. Every capture rebuilds all derived files. Concurrent rebuilds
 *    interleave, and the later writer publishes a registry built from a
 *    snapshot taken before the other's pages existed.
 *
 * A directory is the lock primitive because `mkdir` is atomic on every
 * filesystem worth supporting — unlike "check then create", which reintroduces
 * the race it is meant to close.
 */

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * How long before a held lock is treated as abandoned.
 *
 * Generous on purpose: a capture of a large blob plus a full rebuild is
 * seconds, not minutes, so anything past this is a crashed or killed holder
 * rather than a slow one. Breaking too eagerly would reintroduce the race.
 */
const STALE_AFTER_MS = 60_000;

/** Give up waiting and break the lock rather than fail a capture outright. */
const WAIT_TIMEOUT_MS = 90_000;

const POLL_MS = 25;

export interface LockHolder {
  pid: number;
  label: string;
  acquiredAt: number;
}

const lockDir = (wikiHome: string) => join(wikiHome, ".llm-wiki", "meta", ".lock");

/**
 * When the lock was taken, by whatever evidence exists.
 *
 * The directory's own mtime is the fallback, and it is the important half: a
 * lock is created by mkdir and described by a file written immediately after,
 * so there is a window where it exists with no holder.json. Treating that as
 * abandoned let a second caller delete a live lock and take it — two holders,
 * which is how two captures were handed the same source id.
 */
function heldSince(dir: string, holder: LockHolder | null): number | null {
  if (holder) return holder.acquiredAt;
  try {
    return statSync(dir).mtimeMs;
  } catch {
    return null;
  }
}

function readHolder(dir: string): LockHolder | null {
  try {
    return JSON.parse(readFileSync(join(dir, "holder.json"), "utf8")) as LockHolder;
  } catch {
    return null;
  }
}

/**
 * A lock is stale when its holder is gone or too old.
 *
 * `process.kill(pid, 0)` only proves liveness for holders on this machine; a
 * holder elsewhere falls through to the age check, which is why the age check
 * has to stand on its own rather than being a backstop.
 */
export function isStale(
  holder: LockHolder | null,
  now: number,
  acquiredAt: number | null,
): boolean {
  // Nothing on disk at all: whoever held it is gone.
  if (acquiredAt === null) return true;
  if (now - acquiredAt > STALE_AFTER_MS) return true;

  // A lock too young to have been described yet is held, not abandoned.
  if (!holder) return false;

  try {
    process.kill(holder.pid, 0);
    return false;
  } catch (error) {
    // EPERM means it exists and belongs to another user — alive, not stale.
    return (error as NodeJS.ErrnoException).code !== "EPERM";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` with the vault lock held.
 *
 * Reentrancy is deliberately not supported: every caller is a leaf operation
 * (one capture, one commit, one rebuild), and a nested acquire would mean two
 * such operations had been folded together by mistake.
 */
export async function withVaultLock<T>(
  wikiHome: string,
  label: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const dir = lockDir(wikiHome);
  const deadline = Date.now() + WAIT_TIMEOUT_MS;

  for (;;) {
    try {
      mkdirSync(dir, { recursive: false });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        // The meta directory may not exist yet on a fresh vault.
        mkdirSync(join(wikiHome, ".llm-wiki", "meta"), { recursive: true });
        continue;
      }
    }

    const now = Date.now();
    const holder = readHolder(dir);
    if (isStale(holder, now, heldSince(dir, holder)) || now > deadline) {
      // Break rather than fail: a capture lost to a crashed holder is worse
      // than one that proceeds a little late.
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Another waiter broke it first; the next mkdir decides the winner.
      }
      continue;
    }

    await sleep(POLL_MS + Math.floor(Math.random() * POLL_MS));
  }

  const holder: LockHolder = { pid: process.pid, label, acquiredAt: Date.now() };
  try {
    writeFileSync(join(dir, "holder.json"), JSON.stringify(holder), "utf8");
  } catch {
    // A lock we hold but cannot describe is still a held lock.
  }

  try {
    return await fn();
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Left behind, but the staleness check reclaims it.
    }
  }
}
