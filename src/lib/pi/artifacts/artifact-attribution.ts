/**
 * Which tool calls can produce an artifact, which projects a call might have
 * touched, and pure differencing of two snapshots into an artifact-ready
 * shape.
 *
 * Deliberately git-free: everything here is a pure function over plain data,
 * so the whole attribution policy is testable without a repository on disk.
 * The git-shelling half lives in artifact-snapshot.ts and artifact-capture.ts.
 */

import type { ChangedFile, ChangeStatus } from "@/lib/review/review-types";

/** Tools that can change a working copy. Anything else is skipped outright. */
export const MUTATING_TOOLS = new Set(["edit", "write", "bash"]);

export function isMutatingTool(toolName: string): boolean {
  return MUTATING_TOOLS.has(toolName);
}

/** The most projects a single call's candidates may be snapshotted against. */
export const SNAPSHOT_PROJECT_CAP = 4;

/**
 * The projects a mutating call could have touched, capped.
 *
 * edit/write: the one project owning the typed path.
 * bash: the project owning agentCwd, plus the session's already-linked
 *   projects — a `cd ../other && git commit` is real and the typed path does
 *   not exist. Capped at SNAPSHOT_PROJECT_CAP so a session linked to many
 *   repos does not pay two subprocesses per project per shell command.
 */
export function candidateProjects(input: {
  toolName: string;
  writtenPath: string | null;
  cwdProject: string | null;
  linkedProjects: readonly string[];
}): string[] {
  if (input.toolName === "edit" || input.toolName === "write") {
    return input.writtenPath ? [input.writtenPath] : [];
  }

  const ordered: string[] = [];
  const seen = new Set<string>();
  const add = (project: string | null) => {
    if (!project || seen.has(project)) return;
    seen.add(project);
    ordered.push(project);
  };

  add(input.cwdProject);
  for (const project of input.linkedProjects) add(project);

  return ordered.slice(0, SNAPSHOT_PROJECT_CAP);
}

/** The minimal shape diffSnapshots needs, so tests construct plain literals. */
export interface ProjectSnapshotLike {
  head: string | null;
  files: readonly ChangedFile[];
}

export interface SnapshotDiffResult {
  changed: boolean;
  /** Paths whose status appeared or changed. Not a whole-tree dump. */
  paths: { path: string; oldPath: string | null; status: ChangeStatus }[];
  /** True when HEAD moved between the two snapshots — a commit happened. */
  committed: boolean;
}

/** `path -> "indexCode worktreeCode"`, the pair that decides "changed". */
function codesOf(files: readonly ChangedFile[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const file of files) {
    map.set(file.path, `${file.indexCode}${file.worktreeCode}`);
  }
  return map;
}

/**
 * What changed between two snapshots of the same project.
 *
 * A path dirty in both snapshots with the same codes is not reported: nothing
 * about it changed between the two reads, so attributing it to the call in
 * between would be a guess dressed as an observation.
 */
export function diffSnapshots(
  before: ProjectSnapshotLike,
  after: ProjectSnapshotLike,
): SnapshotDiffResult {
  const committed = before.head !== after.head;
  const beforeCodes = codesOf(before.files);

  const paths: SnapshotDiffResult["paths"] = [];
  for (const file of after.files) {
    const beforeCode = beforeCodes.get(file.path);
    const afterCode = `${file.indexCode}${file.worktreeCode}`;
    if (beforeCode === afterCode) continue;
    paths.push({ oldPath: file.oldPath, path: file.path, status: file.status });
  }

  return { changed: committed || paths.length > 0, committed, paths };
}
