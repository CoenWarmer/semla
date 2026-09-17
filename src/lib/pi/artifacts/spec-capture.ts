/**
 * Turning a captured requirement — an `@spec`-marked turn, or a submitted
 * `capture_feature_spec` form — into a `SpecArtifact` and persisting it the
 * same way every other artifact is persisted: appended to
 * `.semla-artifacts/sessions/<id>/artifacts.jsonl` first (authoritative),
 * then queued for the Postgres mirror. See artifact-record.ts's docblock for
 * why that ordering is the rule everywhere in this tree.
 *
 * Deliberately not a third disk file and not a second reader: a spec
 * artifact is a `SessionArtifact` like any other, so the whole existing
 * pipeline (tail-read cache, dedupe-by-key, the persist queue) already
 * does the right thing for it. See the plan's §1 for why a fourth
 * `ArtifactKind` was chosen over a sibling record type.
 *
 * `isCapturedSpec` (spec-inclusion.ts) is the caller's job, not this
 * module's: a blank form or an unmarked turn should never reach here at
 * all, so a no-op guard inside this file would only hide a caller that
 * forgot to check.
 */

import { appendArtifacts } from "@/lib/pi/artifacts/artifact-store";
import { queueArtifacts } from "@/lib/pi/artifacts/artifact-persist-queue";
import { specArtifactKey } from "@/lib/pi/artifacts/artifact-key";
import type { SpecArtifact, SpecField } from "@/lib/artifacts/artifact-types";

interface RecordSpecInput {
  sessionId: string;
  turnId: string | null;
  roundId: string | null;
}

function persist(artifact: SpecArtifact): void {
  appendArtifacts(artifact.sessionId, [artifact]);
  queueArtifacts(artifact.sessionId, [artifact]);
}

/**
 * Record an `@spec`-marked turn as a spec artifact.
 *
 * `discriminator` is the fixed literal `"marker"`: at most one marker spec
 * artifact exists per turn, since `before_agent_start` fires once per real
 * user turn (spec-persistence.ts's own bet, unchanged here). A double fire
 * for the same turn produces the same key, which dedupe-by-key on read
 * collapses to one entry rather than two.
 */
export function recordMarkerSpec(
  input: RecordSpecInput & { text: string; turnIndex: number | null },
): void {
  const createdAt = new Date().toISOString();
  const artifact: SpecArtifact = {
    attribution: "turn",
    createdAt,
    fields: [],
    key: specArtifactKey(input.turnId, "marker"),
    kind: "spec",
    projectPath: null,
    roundId: input.roundId,
    sessionId: input.sessionId,
    source: "marker",
    text: input.text,
    toolCallId: null,
    toolName: null,
    turnId: input.turnId,
    turnIndex: input.turnIndex,
  };
  persist(artifact);
}

/**
 * Record a submitted `capture_feature_spec` form as a spec artifact.
 *
 * `toolCallId` is the discriminator: it is what makes the key deterministic
 * for a specific submission and what ties the artifact to the transcript
 * card the tool call itself rendered.
 */
export function recordFeatureSpec(
  input: RecordSpecInput & { toolCallId: string; fields: readonly SpecField[]; text: string },
): void {
  const createdAt = new Date().toISOString();
  const artifact: SpecArtifact = {
    attribution: "tool-call",
    createdAt,
    fields: [...input.fields],
    key: specArtifactKey(input.turnId, input.toolCallId),
    kind: "spec",
    projectPath: null,
    roundId: input.roundId,
    sessionId: input.sessionId,
    source: "form",
    text: input.text,
    toolCallId: input.toolCallId,
    toolName: "capture_feature_spec",
    turnId: input.turnId,
    turnIndex: null,
  };
  persist(artifact);
}
