/**
 * Phase 1's status, read rather than recorded.
 *
 * **There is no `code-index.json`, deliberately.** `head.json` already carries
 * `updated`, `chunks`, `model` and `merkleRoot`, and `store.head()` reads it —
 * that is what `getProjectIndexStatuses` shows the settings panel. Writing a
 * second `capturedAt` for the code index would create two answers to "when was
 * this last indexed" that can disagree, and the derived one is the one that
 * cannot lie. So phase 1 is reportable and persisted; its persistence is just
 * not orient's file.
 *
 * **Staleness here is `unknown`, and that is the honest answer at this cost.**
 * The real comparison is `treeRoot(fingerprints) !== head.merkleRoot`, which
 * `freshness()` performs at query time by enumerating and hashing the whole
 * tree. That is affordable per `code_search` call, where it already happens;
 * it is not affordable on a status report or on a per-turn prompt nudge. So
 * this module reports what the head says and says plainly that it did not
 * recompute the root, rather than inventing a cheaper proxy that would be wrong
 * in exactly the window that matters — the sha is constant while the agent
 * edits, which is precisely when the index goes stale.
 */

import { getIndexRun } from "@/lib/code-index/index-runs";
import { projectKey } from "@/lib/code-index/index-paths";
import { createLocalVectorStore } from "@/lib/code-index/store/local";
import type { VectorStore } from "@/lib/code-index/store/types";

export interface IndexPhaseStatus {
  /** False when the project has no head.json — a first-class state. */
  indexed: boolean;
  /** ISO timestamp of the last completed run, from head.json. */
  updated: string | null;
  chunks: number | null;
  model: string | null;
  merkleRoot: string | null;
  /** True while a run for this project is in flight in this process. */
  running: boolean;
  /** Last run's error, when it failed. */
  error: string | null;
}

export async function readIndexPhaseStatus(
  projectRoot: string,
  store: VectorStore = createLocalVectorStore(),
): Promise<IndexPhaseStatus> {
  const head = await store.head(projectKey(projectRoot));
  const run = getIndexRun(projectRoot);

  return {
    chunks: head?.chunks ?? null,
    error: run?.error ?? null,
    indexed: head !== null,
    merkleRoot: head?.merkleRoot ?? null,
    model: head?.model ?? null,
    running: run !== null && run.finishedAt === null,
    updated: head?.updated ?? null,
  };
}
