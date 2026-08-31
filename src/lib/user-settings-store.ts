/**
 * User settings on disk.
 *
 * The chosen model and the system prompt override are two small fields that
 * decide how every session behaves, and they lived only in Postgres — so with
 * the database unavailable a session fell back to the default prompt and had no
 * model to run, which looks like Semla being broken rather than the database
 * being away.
 *
 * Kept beside Semla's other state rather than in the session directory: they
 * belong to the install, not to a session, and a file there would be read as
 * one by listSessionMeta.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SEMLA_STATE_DIR =
  process.env.SEMLA_STATE_DIR?.trim() || join(process.cwd(), ".semla-state");

export interface UserSettings {
  defaultModelId: string | null;
  defaultModelProvider: string | null;
  systemPrompt: string | null;
}

const EMPTY: UserSettings = {
  defaultModelId: null,
  defaultModelProvider: null,
  systemPrompt: null,
};

const settingsPath = (userId: string, dir: string) =>
  // Namespaced by user so an exposed instance does not hand one person's
  // system prompt to another.
  join(dir, `user-settings.${userId}.json`);

export function readUserSettings(
  userId: string,
  dir = SEMLA_STATE_DIR,
): UserSettings | null {
  try {
    const parsed = JSON.parse(
      readFileSync(settingsPath(userId, dir), "utf8"),
    ) as Partial<UserSettings>;
    return { ...EMPTY, ...parsed };
  } catch {
    return null;
  }
}

/**
 * Merge fields into a user's settings, creating the record if absent.
 *
 * Merged rather than replaced because the UI saves the model and the system
 * prompt from different screens; a whole-record write would let one erase the
 * other.
 */
export function writeUserSettings(
  userId: string,
  patch: Partial<UserSettings>,
  dir = SEMLA_STATE_DIR,
): UserSettings {
  mkdirSync(dir, { recursive: true });
  const next: UserSettings = { ...(readUserSettings(userId, dir) ?? EMPTY), ...patch };
  writeFileSync(settingsPath(userId, dir), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}
