/**
 * What the settings panel shows: every workspace project, and whether it has an
 * index.
 *
 * A project with no index is a first-class state, not an error and not an
 * omission — indexing is opt-in per project, so "not indexed" is the default
 * and the panel exists to change it deliberately.
 */

import { getWorkspaceProjects } from "@/lib/pi/workspace";

import { getIndexRun } from "./index-runs";
import { projectKey } from "./index-paths";
import { createLocalVectorStore } from "./store/local";
import type { VectorStore } from "./store/types";

export interface ProjectIndexStatus {
  name: string;
  path: string;
  indexed: boolean;
  chunks: number | null;
  model: string | null;
  updated: string | null;
  /** Set while a run is in flight or has just finished. */
  run: {
    running: boolean;
    phase: string;
    done: number;
    total: number;
    tokens: number;
    cost: number;
    error: string | null;
  } | null;
}

export async function getProjectIndexStatuses(
  store: VectorStore = createLocalVectorStore(),
): Promise<ProjectIndexStatus[]> {
  const projects = await getWorkspaceProjects();

  return Promise.all(
    projects.map(async (project) => {
      const head = await store.head(projectKey(project.path));
      const run = getIndexRun(project.path);

      return {
        name: project.name,
        path: project.path,
        indexed: head !== null,
        chunks: head?.chunks ?? null,
        model: head?.model ?? null,
        updated: head?.updated ?? null,
        run:
          run === null
            ? null
            : {
                running: run.finishedAt === null,
                phase: run.progress.phase,
                done: run.progress.done,
                total: run.progress.total,
                tokens: run.tokens,
                cost: run.cost,
                error: run.error,
              },
      };
    }),
  );
}
