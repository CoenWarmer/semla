/**
 * Resizable panel sizes, on disk.
 *
 * Every panel in the app that a drag can resize (`react-resizable-panels`
 * groups, the bottom bar's drag-to-resize height, the agent transcript
 * drawer's drag-to-resize width) reset to their defaults on every reload,
 * because nothing outlived the render tree that held the size in `useState`.
 *
 * Kept beside Semla's other per-user install state rather than in the
 * session directory, for the same reason `user-settings-store.ts` gives: a
 * stray file in the session directory is read as a session by
 * `listSessionMeta`. There is no Postgres mirror — a panel's size is a
 * preference about the local screen it was dragged on, not something worth
 * carrying between installs, and unlike the model or the system prompt a
 * lost layout costs nothing but a redrag.
 *
 * One record per user, keyed by an arbitrary string per layout so any number
 * of independent panel groups (the review/conversation split, the review
 * panel's own two splits, the bottom bar's height, the transcript drawer's
 * width) can share the file without stepping on each other.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SEMLA_STATE_DIR } from "@/lib/user-settings-store";

/**
 * One saved layout's value.
 *
 * A `react-resizable-panels` layout is a map of panel id to percentage; a
 * drag-to-resize height or width is a single pixel number. A `boolean` is
 * for the one non-size preference kept in the same file — whether the review
 * file tree shows dotted names — because it is the same shape of
 * "per-user, per-screen, not worth a Postgres round-trip" preference this
 * file already exists for, and a second file would just mean a second read
 * on the same panel's mount. All three are stored the same way so one API
 * and one file serve every panel in the app.
 */
export type PanelLayoutValue = number | boolean | Record<string, number>;

export type PanelLayouts = Record<string, PanelLayoutValue>;

const LAYOUT_DIR = "panel-layout";

const layoutPath = (userId: string, dir: string) =>
  join(dir, LAYOUT_DIR, `${userId}.json`);

export function readPanelLayouts(
  userId: string,
  dir = SEMLA_STATE_DIR,
): PanelLayouts | null {
  try {
    return JSON.parse(
      readFileSync(layoutPath(userId, dir), "utf8"),
    ) as PanelLayouts;
  } catch {
    return null;
  }
}

/**
 * Merge one or more named layouts into a user's record, creating it if
 * absent.
 *
 * Merged rather than replaced: each resizable group saves its own key
 * independently, on its own drag, and a whole-record write from one would
 * erase every other panel's last-saved size.
 */
export function writePanelLayouts(
  userId: string,
  patch: PanelLayouts,
  dir = SEMLA_STATE_DIR,
): PanelLayouts {
  mkdirSync(join(dir, LAYOUT_DIR), { recursive: true });
  const next: PanelLayouts = { ...(readPanelLayouts(userId, dir) ?? {}), ...patch };
  writeFileSync(layoutPath(userId, dir), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}
