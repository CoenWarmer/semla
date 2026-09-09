/**
 * In-process registry of running index jobs.
 *
 * An ingest is seconds to minutes of embedding round-trips, so the route that
 * starts one cannot await it — a request that hangs for a minute is
 * indistinguishable from one that has failed, and a browser will give up on it
 * first. The POST starts a run and returns; the GET reports where it got to.
 *
 * Deliberately in-process and unpersisted, unlike a workflow run. There is
 * nothing here worth surviving a restart: the index itself is on disk and
 * already durable, and a run interrupted halfway has written every chunk it
 * embedded before dying. Restarting it costs only the files it had not reached,
 * because the next run diffs against what is stored. Persisting run *state*
 * would add a second thing that can disagree with the index for no gain.
 *
 * One run per project at a time. Two concurrent runs over one project would
 * both diff against the same stored manifest, embed the same files, and race
 * each other's upserts — arriving at a correct index by luck, having paid twice.
 *
 * Progress is pushed to subscribers rather than polled. An ingest emits a phase
 * change per file and then sits in one embedding call for seconds; polling that
 * either misses the fast part or spends most of its requests learning nothing.
 * `subscribeToIndexRuns` is shaped like `subscribeToTerminal` so the SSE route
 * over it can be framed identically to the terminal and session streams, which
 * the client already knows how to read.
 */

import { resolveEmbedder } from "./credentials";
import { indexProject, type IndexProgress, type IndexReport } from "./indexer";
import { projectKey } from "./index-paths";
import { createLocalVectorStore } from "./store/local";
import type { ProjectKey } from "./types";

export interface IndexRun {
  project: ProjectKey;
  root: string;
  startedAt: number;
  finishedAt: number | null;
  progress: IndexProgress;
  /** Accumulated from the embedder, which is the only thing that sees usage. */
  tokens: number;
  cost: number;
  report: IndexReport | null;
  error: string | null;
}

const runs = new Map<ProjectKey, IndexRun>();

export type IndexRunSubscriber = (run: IndexRun) => void;

const subscribers = new Set<IndexRunSubscriber>();

/**
 * Watch every run. Current runs are replayed on subscribe, so a client that
 * connects mid-ingest sees where it is rather than waiting for the next tick.
 */
export function subscribeToIndexRuns(onChange: IndexRunSubscriber): {
  unsubscribe: () => void;
} {
  for (const run of runs.values()) onChange(run);
  subscribers.add(onChange);
  return { unsubscribe: () => subscribers.delete(onChange) };
}

function publish(run: IndexRun): void {
  for (const subscriber of subscribers) {
    try {
      subscriber(run);
    } catch {
      // A broken subscriber is a closed stream, not a reason to fail the index.
    }
  }
}

/** True while a run for this project is in flight. */
export function isIndexRunning(root: string): boolean {
  const run = runs.get(projectKey(root));
  return run !== undefined && run.finishedAt === null;
}

export function getIndexRun(root: string): IndexRun | null {
  return runs.get(projectKey(root)) ?? null;
}

export function listIndexRuns(): IndexRun[] {
  return [...runs.values()];
}

export class NoEmbeddingCredentialError extends Error {
  constructor() {
    super(
      "No embedding credential is configured. Semla reads the `openrouter` entry " +
        "from its agent directory (~/.semla/agent/auth.json).",
    );
  }
}

/**
 * Start indexing `root`, or return the run already in flight for it.
 *
 * Returns as soon as the run is registered. The promise the work runs on is
 * deliberately not returned: nothing should await it, and handing it out
 * invites a caller to.
 */
export function startIndexRun(root: string): IndexRun {
  const project = projectKey(root);
  const existing = runs.get(project);
  if (existing !== undefined && existing.finishedAt === null) return existing;

  const run: IndexRun = {
    project,
    root,
    startedAt: Date.now(),
    finishedAt: null,
    progress: { phase: "scanning", done: 0, total: 0 },
    tokens: 0,
    cost: 0,
    report: null,
    error: null,
  };
  runs.set(project, run);

  const embedder = resolveEmbedder({
    onUsage: (usage) => {
      run.tokens += usage.tokens;
      run.cost += usage.cost ?? 0;
    },
  });

  if (embedder === null) {
    run.error = new NoEmbeddingCredentialError().message;
    run.finishedAt = Date.now();
    publish(run);
    return run;
  }

  publish(run);

  void (async () => {
    try {
      run.report = await indexProject({
        root,
        project,
        store: createLocalVectorStore(),
        embedder,
        onProgress: (progress) => {
          run.progress = progress;
          publish(run);
        },
      });
    } catch (error) {
      // Recorded on the run, never rethrown: nothing is awaiting this, so an
      // unhandled rejection here would take down the server rather than fail
      // the index.
      run.error = error instanceof Error ? error.message : String(error);
    } finally {
      run.finishedAt = Date.now();
      publish(run);
    }
  })();

  return run;
}

/** Test seam. */
export function clearIndexRuns(): void {
  runs.clear();
  subscribers.clear();
}
