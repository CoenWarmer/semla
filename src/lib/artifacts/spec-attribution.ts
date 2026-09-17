/**
 * Which artifacts each spec is answerable for — the join the whole feature
 * exists for. Pure and client-safe (see artifact-types.ts's docblock for
 * why: the sidebar reads this with no server hop, and client-boundary.test.ts
 * enforces that nothing here reaches node:fs or the pi package).
 *
 * Two link strengths, deliberately distinguished rather than merged:
 *
 *  - "same-turn": artifact.turnId === spec.turnId. A fact. The requirement
 *    was stated and the change was made inside one prompt turn.
 *  - "after": the artifact falls in this spec's interval — createdAt at or
 *    after the spec's, and before the next spec artifact in the session. A
 *    heuristic, and the only answer available for a feature-spec form, whose
 *    whole purpose is to govern the turns that come *after* it. It says
 *    "produced under this requirement", not "caused by it".
 *
 * Artifacts with turnId === null are attributed by interval only, never by
 * turn — there is nothing to compare. Artifacts before the first spec belong
 * to no spec and come back in `unattributed`.
 *
 * Known, stated rather than hidden: subagent workflow sessions never reach
 * the turn-event router (see the plan's §0 and artifact-capture.ts), so a
 * subagent's edits are misattributed to the host's next tool call and now
 * also to the host's turnId. A "same-turn" link on such an artifact is true
 * of the host turn that was in flight, which is coarser than it looks.
 */

import type { SessionArtifact, SpecArtifact } from "@/lib/artifacts/artifact-types";

export type SpecLinkStrength = "same-turn" | "after";

export interface SpecProduced {
  artifact: SessionArtifact;
  strength: SpecLinkStrength;
}

export interface SpecAttribution {
  spec: SpecArtifact;
  /** Ordered oldest-first. */
  produced: SpecProduced[];
}

export interface AttributeArtifactsResult {
  /** Ordered oldest-spec-first. */
  specs: SpecAttribution[];
  /** Artifacts that predate every spec in the session. */
  unattributed: SessionArtifact[];
}

function isSpec(artifact: SessionArtifact): artifact is SpecArtifact {
  return artifact.kind === "spec";
}

/** Oldest first; ties broken by key so ordering is deterministic. */
function byCreatedAtThenKey(a: SessionArtifact, b: SessionArtifact): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * Attribute every non-spec artifact to the spec(s) it plausibly answers.
 *
 * A "same-turn" link is exact and can attach an artifact to more than one
 * spec (two specs captured in the same turn, e.g. an `@spec` marker and a
 * feature-spec form both submitted in one round trip). An "after" link is a
 * window: at most one spec, the nearest preceding one, because widening it
 * to every earlier spec would answer nothing.
 */
export function attributeArtifactsToSpecs(
  artifacts: readonly SessionArtifact[],
): AttributeArtifactsResult {
  const ordered = [...artifacts].sort(byCreatedAtThenKey);
  const specArtifacts = ordered.filter(isSpec);
  const rest = ordered.filter((artifact): artifact is Exclude<SessionArtifact, SpecArtifact> =>
    !isSpec(artifact),
  );

  const produced = new Map<string, SpecProduced[]>();
  for (const spec of specArtifacts) produced.set(spec.key, []);

  const unattributed: SessionArtifact[] = [];

  for (const artifact of rest) {
    // Every spec whose turnId matches, exactly — an artifact may belong to
    // more than one spec captured in the same turn.
    const sameTurn = artifact.turnId !== null
      ? specArtifacts.filter((spec) => spec.turnId === artifact.turnId)
      : [];
    for (const spec of sameTurn) {
      produced.get(spec.key)!.push({ artifact, strength: "same-turn" });
    }

    // The nearest preceding spec this artifact was not already linked to by
    // turn — its interval, i.e. the window before the next spec.
    let nearest: SpecArtifact | null = null;
    for (const spec of specArtifacts) {
      if (spec.createdAt > artifact.createdAt) break;
      nearest = spec;
    }
    if (nearest && !sameTurn.some((s) => s.key === nearest!.key)) {
      produced.get(nearest.key)!.push({ artifact, strength: "after" });
    }
    if (!nearest && sameTurn.length === 0) unattributed.push(artifact);
  }

  return {
    specs: specArtifacts.map((spec) => ({ produced: produced.get(spec.key)!, spec })),
    unattributed,
  };
}
