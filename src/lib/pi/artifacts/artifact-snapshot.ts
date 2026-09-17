/**
 * Reading one project's git state, cheaply and honestly.
 *
 * Two subprocesses, reusing the same readers review-status.ts already shells
 * out with — `readHeadSha` and `readChangedFiles` — so this is not a second
 * definition of "what is HEAD" or "what is dirty". The fingerprint is reused
 * from review-turn-mark.ts for the same reason: two modules computing "did
 * anything change" must never disagree about what that means.
 */

import { readChangedFiles, readHeadSha } from "@/lib/pi/review/review-status";
import { fingerprint } from "@/lib/pi/review/review-turn-mark";
import type { ChangedFile } from "@/lib/review/review-types";

export interface ProjectSnapshot {
  /** Workspace-relative. */
  projectPath: string;
  /** Absolute repository root. */
  root: string;
  head: string | null;
  files: ChangedFile[];
  /** fingerprint(head, files) — the single value diffing compares. */
  state: string;
  at: string;
}

/** Two git subprocesses: rev-parse HEAD + status --porcelain. */
export async function readProjectSnapshot(
  projectPath: string,
  root: string,
): Promise<ProjectSnapshot> {
  const [head, { files }] = await Promise.all([
    readHeadSha(root),
    readChangedFiles(root),
  ]);

  return {
    at: new Date().toISOString(),
    files,
    head,
    projectPath,
    root,
    state: fingerprint(head, files),
  };
}
