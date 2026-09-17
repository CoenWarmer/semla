/**
 * Turning one mutating tool call into the artifacts it produced.
 *
 * Every git-shelling step is an injected parameter with a production
 * default, not a direct call to review-status.ts / review-diff.ts. That is
 * what makes the cost budget in the plan (§2.7) a testable fact rather than a
 * claim: a test can assert "unchanged state costs zero diff/commit reads"
 * without spawning git at all.
 *
 * The snapshot chain (artifact-snapshot-cache.ts) is what makes a "before"
 * read unnecessary here: `before` is always a cache lookup, never a fresh
 * git call, and a miss returns `[]` while still caching `after` so the next
 * call in this project is attributable.
 */

import {
  ARTIFACT_FILE_CAP,
  ARTIFACT_HUNK_FILES,
  ARTIFACT_HUNKS_PER_FILE,
  ARTIFACT_PATCH_BYTES,
  type ArtifactAttribution,
  type ArtifactFile,
  type CommitArtifact,
  type DiffArtifact,
  type HunkAnchor,
  type PrArtifact,
  type SessionArtifact,
} from "@/lib/artifacts/artifact-types";
import { resolveDiffRole } from "@/lib/artifacts/diff-role";
import { artifactKey } from "@/lib/pi/artifacts/artifact-key";
import { diffSnapshots } from "@/lib/pi/artifacts/artifact-attribution";
import {
  getSnapshot,
  putSnapshot,
} from "@/lib/pi/artifacts/artifact-snapshot-cache";
import { readProjectSnapshot } from "@/lib/pi/artifacts/artifact-snapshot";
import { detectPullRequests } from "@/lib/pi/artifacts/pr-detect";
import { readFileDiff, readUntrackedDiff } from "@/lib/pi/review/review-diff";
import { readTurnCommits } from "@/lib/pi/review/review-status";
import type { FileDiff, TurnCommit } from "@/lib/review/review-types";

export interface CaptureInput {
  sessionId: string;
  /**
   * The durable prompt-turn id this call happened under, or null when there
   * is none in flight (a background continuation). See ArtifactCore.turnId.
   */
  turnId: string | null;
  roundId: string | null;
  toolCallId: string | null;
  toolName: string | null;
  attribution: ArtifactAttribution;
  /** The absolute project roots to check, keyed by workspace-relative path. */
  projects: readonly { projectPath: string; root: string }[];
  /** bash only: the command and its result text, for PR detection. */
  command: string | null;
  output: string | null;
  /**
   * The `role` argument the agent passed on this tool call, if any — the
   * declared half of diff-role.ts. Unvalidated here on purpose: it is
   * model-supplied, and `resolveDiffRole` is the one place that decides what
   * counts, so a typo costs the role rather than the artifact.
   */
  declaredRole?: unknown;
  /**
   * The path an edit/write named, used only as the inferred fallback for a
   * diff's role. Null for bash, which names no single file — a shell command
   * that happens to write a plan gets no inferred role, which is the honest
   * answer rather than a guess from a command string.
   */
  writtenPath?: string | null;
  /** Only present for a "turn" attribution artifact. */
  turnStartedAt?: string | null;
}

/** Injected git readers, so the cost budget is a testable fact. */
export interface CaptureDeps {
  readSnapshot: typeof readProjectSnapshot;
  readDiff: (root: string, path: string, untracked: boolean) => Promise<FileDiff | null>;
  readCommits: (root: string, startSha: string | null) => Promise<TurnCommit[]>;
}

const defaultReadDiff: CaptureDeps["readDiff"] = (root, path, untracked) =>
  untracked ? readUntrackedDiff(root, path) : readFileDiff(root, path, "head");

const DEFAULT_DEPS: CaptureDeps = {
  readCommits: readTurnCommits,
  readDiff: defaultReadDiff,
  readSnapshot: readProjectSnapshot,
};

function toAnchor(hunk: {
  index: number;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  heading: string;
}): HunkAnchor {
  return {
    heading: hunk.heading || null,
    index: hunk.index,
    newLines: hunk.newLines,
    newStart: hunk.newStart,
    oldLines: hunk.oldLines,
    oldStart: hunk.oldStart,
  };
}

/** Truncate a growing patch body at ARTIFACT_PATCH_BYTES, UTF-8 aware enough. */
function appendPatch(
  patch: string,
  truncated: boolean,
  addition: string,
): { patch: string; truncated: boolean } {
  if (truncated) return { patch, truncated };
  const combined = patch + addition;
  if (Buffer.byteLength(combined, "utf8") <= ARTIFACT_PATCH_BYTES) {
    return { patch: combined, truncated: false };
  }
  return { patch, truncated: true };
}

interface DiffCaptureResult {
  artifact: DiffArtifact;
  patch: string;
}

async function captureDiffArtifact(
  input: CaptureInput,
  project: { projectPath: string; root: string },
  before: { head: string | null; state: string; files: readonly import("@/lib/review/review-types").ChangedFile[] },
  after: { head: string | null; state: string; files: readonly import("@/lib/review/review-types").ChangedFile[] },
  deps: CaptureDeps,
  createdAt: string,
): Promise<DiffCaptureResult | null> {
  const diff = diffSnapshots(before, after);
  if (diff.paths.length === 0) return null;

  const capped = diff.paths.slice(0, ARTIFACT_FILE_CAP);
  const filesOmitted = Math.max(0, diff.paths.length - capped.length);

  const afterByPath = new Map(after.files.map((f) => [f.path, f]));

  let patch = "";
  let patchTruncated = false;
  const files: ArtifactFile[] = [];

  for (let i = 0; i < capped.length; i += 1) {
    const entry = capped[i];
    const readHunks = i < ARTIFACT_HUNK_FILES;
    const changedFile = afterByPath.get(entry.path);

    let hunks: HunkAnchor[] = [];
    let hunksOmitted = false;

    if (readHunks) {
      const untracked = changedFile?.status === "untracked";
      const fileDiff = await deps.readDiff(project.root, entry.path, untracked);
      if (fileDiff) {
        hunks = fileDiff.hunks.slice(0, ARTIFACT_HUNKS_PER_FILE).map(toAnchor);
        hunksOmitted = fileDiff.hunks.length > hunks.length;
        const body = fileDiff.hunks
          .map((h) => h.lines.map((l) => l.text).join("\n"))
          .join("\n");
        const appended = appendPatch(
          patch,
          patchTruncated,
          `${fileDiff.header}\n${body}\n`,
        );
        patch = appended.patch;
        patchTruncated = appended.truncated;
      }
    } else {
      hunksOmitted = true;
    }

    files.push({
      hunks,
      hunksOmitted,
      oldPath: entry.oldPath,
      path: entry.path,
      status: entry.status,
    });
  }

  return {
    artifact: {
      attribution: input.attribution,
      baseSha: before.head,
      createdAt,
      filesOmitted,
      files,
      headSha: after.head,
      kind: "diff",
      key: artifactKey({
        attribution: input.attribution,
        discriminator: "0",
        kind: "diff",
        projectPath: project.projectPath,
        toolCallId: input.toolCallId,
        turnStartedAt: input.turnStartedAt ?? null,
      }),
      // Filled in by the caller that writes the sidecar (artifact-record.ts),
      // once the patch text below has been persisted.
      patchFile: null,
      patchTruncated,
      projectPath: project.projectPath,
      role: resolveDiffRole({
        declared: input.declaredRole,
        writtenPath: input.writtenPath ?? null,
      }),
      roundId: input.roundId,
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      turnId: input.turnId,
    },
    patch,
  };
}

function captureCommitArtifacts(
  input: CaptureInput,
  project: { projectPath: string; root: string },
  commits: readonly TurnCommit[],
  createdAt: string,
): CommitArtifact[] {
  return commits.map((commit) => ({
    at: commit.at,
    attribution: input.attribution,
    author: commit.author,
    createdAt,
    fileCount: commit.fileCount,
    files: commit.files.slice(0, ARTIFACT_FILE_CAP),
    kind: "commit",
    key: artifactKey({
      attribution: input.attribution,
      discriminator: commit.sha,
      kind: "commit",
      projectPath: project.projectPath,
      toolCallId: input.toolCallId,
      turnStartedAt: input.turnStartedAt ?? null,
    }),
    projectPath: project.projectPath,
    roundId: input.roundId,
    sessionId: input.sessionId,
    sha: commit.sha,
    shortSha: commit.shortSha,
    subject: commit.subject,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    turnId: input.turnId,
  }));
}

function capturePrArtifacts(
  input: CaptureInput,
  project: { projectPath: string; root: string },
  createdAt: string,
): PrArtifact[] {
  const detected = detectPullRequests({ command: input.command, output: input.output });
  return detected.map((pr) => ({
    attribution: input.attribution,
    command: (input.command ?? "").slice(0, 200),
    createdAt,
    kind: "pr",
    key: artifactKey({
      attribution: input.attribution,
      discriminator: pr.url,
      kind: "pr",
      projectPath: project.projectPath,
      toolCallId: input.toolCallId,
      turnStartedAt: input.turnStartedAt ?? null,
    }),
    number: pr.number,
    projectPath: project.projectPath,
    repo: pr.repo,
    roundId: input.roundId,
    sessionId: input.sessionId,
    source: "gh-cli",
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    turnId: input.turnId,
    url: pr.url,
  }));
}

export interface CaptureResult {
  artifacts: SessionArtifact[];
  /** Patch text for each diff artifact's key, for the caller to write to disk. */
  patches: Map<string, string>;
}

/**
 * Everything a capture produced. Never throws; failures return an empty
 * result for that project.
 */
export async function captureArtifacts(
  input: CaptureInput,
  deps: CaptureDeps = DEFAULT_DEPS,
): Promise<CaptureResult> {
  const artifacts: SessionArtifact[] = [];
  const patches = new Map<string, string>();
  const createdAt = new Date().toISOString();

  // A PR is project-independent — emitted once per call, attributed to the
  // first candidate project (or skipped entirely with no candidates).
  let prEmitted = false;

  for (const project of input.projects) {
    try {
      const before = getSnapshot(input.sessionId, project.projectPath);

      const after = await deps.readSnapshot(project.projectPath, project.root);
      putSnapshot(input.sessionId, after);

      if (!prEmitted) {
        const prs = capturePrArtifacts(input, project, createdAt);
        if (prs.length > 0) {
          artifacts.push(...prs);
          prEmitted = true;
        }
      }

      if (!before) continue; // cache miss: nothing to compare, but now seeded
      if (before.state === after.state) continue; // no further git calls

      if (before.head !== after.head) {
        const commits = await deps.readCommits(project.root, before.head);
        artifacts.push(...captureCommitArtifacts(input, project, commits, createdAt));
      }

      const diffResult = await captureDiffArtifact(
        input,
        project,
        before,
        after,
        deps,
        createdAt,
      );
      if (diffResult) {
        if (diffResult.patch) patches.set(diffResult.artifact.key, diffResult.patch);
        artifacts.push(diffResult.artifact);
      }
    } catch {
      // Best-effort by construction: a failure here costs this project's
      // artifact for this call, not the turn.
    }
  }

  return { artifacts, patches };
}
