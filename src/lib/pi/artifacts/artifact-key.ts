/**
 * Deterministic identity for an artifact, and its filesystem-safe form.
 *
 * The key is what makes re-capture an upsert rather than a duplicate: the
 * same tool call, the same commit sha, the same PR url must always produce
 * the same key, on disk and in the Postgres mirror alike. See
 * ArtifactIdentity.key in artifact-types.ts for the exact shape.
 */

import { createHash } from "node:crypto";

import type { ArtifactAttribution, ArtifactKind } from "@/lib/artifacts/artifact-types";

/**
 * Build the key for one artifact.
 *
 * `discriminator` is the commit sha for a commit, the PR url for a pr, and
 * the literal "0" for the one diff a call can produce per project.
 */
export function artifactKey(input: {
  attribution: ArtifactAttribution;
  kind: ArtifactKind;
  discriminator: string;
  /** Required when attribution is "tool-call". */
  toolCallId?: string | null;
  /** Required when attribution is "turn". */
  turnStartedAt?: string | null;
  projectPath: string;
}): string {
  if (input.attribution === "tool-call") {
    return `${input.toolCallId}:${input.kind}:${input.discriminator}`;
  }
  return `turn:${input.turnStartedAt}:${input.projectPath}:${input.kind}:${input.discriminator}`;
}

/**
 * The key for a spec artifact: `spec:<turnId>:<discriminator>`.
 *
 * `discriminator` is `"marker"` for an `@spec`-marked turn (at most one per
 * turn) or the tool call id for a submitted feature-spec form — both
 * deterministic and upsert-safe, so a `before_agent_start` hook firing twice
 * for one turn produces a duplicate JSONL line that dedupe-by-key collapses
 * rather than two distinct spec artifacts. Kept as its own function rather
 * than a branch of `artifactKey` above: a spec has no `toolCallId`/
 * `turnStartedAt`/`projectPath` distinction to make, so folding it in would
 * mean widening that function's parameters for a shape it does not need.
 */
export function specArtifactKey(turnId: string | null, discriminator: string): string {
  return `spec:${turnId}:${discriminator}`;
}

const SAFE_KEY_MAX = 120;

/**
 * A key, made safe as a filename.
 *
 * Non-alphanumeric characters (`:`, `/`, spaces in a subject line reaching
 * into a discriminator) become `_`. A key longer than SAFE_KEY_MAX is cut and
 * a 6-char sha256 prefix of the *original* key is appended, so two keys that
 * share a long common prefix still sanitize to different names.
 */
export function sanitizedArtifactKey(key: string): string {
  const sanitized = key.replace(/[^A-Za-z0-9._-]/g, "_");
  if (sanitized.length <= SAFE_KEY_MAX) return sanitized;

  const hash = createHash("sha256").update(key).digest("hex").slice(0, 6);
  return `${sanitized.slice(0, SAFE_KEY_MAX - 7)}_${hash}`;
}
