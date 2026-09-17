/**
 * What a session produced, attributed to the tool call that produced it.
 *
 * Client-safe by construction: the sidebar renders these and the sidebar is a
 * client component, so nothing here may reach node:fs or the pi package. The
 * server-side capture lives in src/lib/pi/artifacts/*, which imports these.
 *
 * Mirrors the review-types.ts split for the same reason given in that file.
 */

import type { DiffRole } from "@/lib/artifacts/diff-role";
import type { ChangeStatus } from "@/lib/review/review-types";

export type ArtifactKind = "diff" | "commit" | "pr" | "spec";

/**
 * How the artifact found its owner.
 *
 * `tool-call` means a mutating tool call was observed and its id is real.
 * `turn` means the change appeared without an attributable call — a bash
 * command in a project no snapshot covered, or a turn that ended with the
 * working copy moved and no call to blame. A turn-level artifact carries
 * `toolCallId: null`; no id is ever invented. See artifact-attribution.ts.
 */
export type ArtifactAttribution = "tool-call" | "turn";

/**
 * Identity shared by every kind, project-scoped or not.
 *
 * Split out of what used to be the one `ArtifactIdentity` interface so that
 * `projectPath` — required for a code artifact, meaningless for a spec — can
 * be typed exactly at each end rather than fudged with a sentinel. See
 * `ArtifactIdentity` below for the project-scoped extension.
 */
export interface ArtifactCore {
  /**
   * Stable, deterministic, and unique within a session. Re-deriving it from
   * the same capture yields the same value, which is what makes the Postgres
   * mirror an upsert rather than a duplicate-producing insert.
   *
   *   tool-call: `${toolCallId}:${kind}:${discriminator}`
   *   turn:      `turn:${turnStartedAt}:${projectPath}:${kind}:${discriminator}`
   *   spec:      `spec:${turnId}:${discriminator}`
   *
   * `discriminator` is the commit sha for a commit, the PR url for a pr, the
   * literal "0" for the single diff a call produces per project, and
   * "marker" or a tool call id for a spec. See artifact-key.ts.
   */
  key: string;
  sessionId: string;
  /**
   * The durable prompt-turn id (src/lib/pi/session/turn-id.ts), or null when
   * the capture happened outside a prompt turn (a background continuation,
   * which has no turn in flight) or predates turn ids. This is the ONLY join
   * between a requirement (a spec artifact) and the code it produced. Never
   * invented — null means unknown, not a guess.
   */
  turnId: string | null;
  /**
   * The assistant round trip, when known.
   *
   * Advisory only, and null for turn-level artifacts. `roundId` is a
   * client-local id (`live-round-N`, see session-event-router.ts) that is not
   * persisted anywhere else, so it groups chips within one live session and
   * means nothing across a reload. It is recorded because it is free; nothing
   * may key on it.
   */
  roundId: string | null;
  /** Pi's tool call id, or null when attribution is "turn". */
  toolCallId: string | null;
  /** `edit` | `write` | `bash` | null for turn-level. */
  toolName: string | null;
  attribution: ArtifactAttribution;
  createdAt: string;
}

/** Core plus the project a code artifact belongs to. */
export interface ArtifactIdentity extends ArtifactCore {
  /** Workspace-relative, never absolute. Same rule as session_projects. */
  projectPath: string;
}

/** A hunk as it stood when captured — an anchor, not an address. */
export interface HunkAnchor {
  /** Position in the diff read at capture time. Advisory; see the plan §7. */
  index: number;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** git's `@@ ... @@ <heading>` trailer, used to re-find a drifted hunk. */
  heading: string | null;
}

export interface ArtifactFile {
  path: string;
  oldPath: string | null;
  status: ChangeStatus;
  /** Anchors, capped at ARTIFACT_HUNKS_PER_FILE. Empty for binary. */
  hunks: HunkAnchor[];
  /** True when capture stopped short of reading this file's hunks. */
  hunksOmitted: boolean;
}

export interface DiffArtifact extends ArtifactIdentity {
  kind: "diff";
  /**
   * What this diff is *for* — currently only "plan" — or null for the
   * ordinary source edit most diffs are. Carries its own `source` so a
   * declared role and a path-inferred guess never render alike; see
   * diff-role.ts for why that distinction is load-bearing.
   */
  role: DiffRole | null;
  /** HEAD before the call. Null in a repository with no commits. */
  baseSha: string | null;
  headSha: string | null;
  files: ArtifactFile[];
  /** Files beyond ARTIFACT_FILE_CAP, counted not listed. */
  filesOmitted: number;
  /**
   * Session-relative path of the sidecar `.patch`, or null when none was
   * written (over cap, or the write failed). Relative so the record survives
   * the artifact root moving.
   */
  patchFile: string | null;
  patchTruncated: boolean;
}

export interface CommitArtifact extends ArtifactIdentity {
  kind: "commit";
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  /** ISO, from git's %aI. */
  at: string;
  fileCount: number;
  /** Capped at ARTIFACT_FILE_CAP paths. */
  files: string[];
}

export interface PrArtifact extends ArtifactIdentity {
  kind: "pr";
  url: string;
  /** Parsed out of the url; null if the url did not carry one. */
  number: number | null;
  /** The repo slug from the url, e.g. "owner/name". Null if unparsable. */
  repo: string | null;
  /**
   * How it was detected. One value today; an enum so a second mechanism is
   * an added case rather than a silent change of meaning.
   */
  source: "gh-cli";
  /** ≤200 chars of the command that produced it, for provenance. */
  command: string;
}

/** How a spec candidate was captured. See spec-inclusion.ts for the inclusion rule. */
export type SpecSource = "marker" | "form";

export interface SpecField {
  label: string;
  value: string;
}

export interface SpecArtifact extends ArtifactCore {
  kind: "spec";
  /**
   * Null, not a sentinel: a requirement is stated to the session, not to one
   * repository, and a session can be anchored to several. Naming one of
   * them would be a claim the operator never made.
   */
  projectPath: null;
  source: SpecSource;
  /** SPEC.md's own ordinal for this turn; null for a form (no SPEC.md line). */
  turnIndex: number | null;
  /** Verbatim operator text, `@spec` stripped. For a form: the goal field. */
  text: string;
  /**
   * The form's structured fields, in submission order. Empty for "marker".
   * Captured at the source, so this is not re-derived from tool-result prose
   * the way feature-spec-record.ts has to for a transcript-only session.
   */
  fields: SpecField[];
}

export type SessionArtifact = DiffArtifact | CommitArtifact | PrArtifact | SpecArtifact;

export const ARTIFACT_FILE_CAP = 50;
export const ARTIFACT_HUNK_FILES = 10;
export const ARTIFACT_HUNKS_PER_FILE = 40;
export const ARTIFACT_PATCH_BYTES = 256 * 1024;
