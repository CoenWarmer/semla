/**
 * Which spec candidates become a `SpecArtifact` at all.
 *
 * SPEC.md logs every user turn verbatim (spec-log.ts), and the sidebar caps
 * chips at CHIP_CAP and orders them by recency — so capturing every turn as
 * an artifact would push every diff off the row within two turns and answer
 * nothing. Only two things are captured: an `@spec`-marked turn, and a
 * submitted `capture_feature_spec` form. Both mean "the operator explicitly
 * stated scope"; they differ in ceremony and in whether they carry structure,
 * which is why they are distinguished by `source` rather than by two kinds.
 *
 * Pure and client-safe: no I/O, so it can be shared between the server-side
 * capture in src/lib/pi/artifacts/spec-capture.ts and any future UI logic
 * without either side reaching across the boundary.
 */

import type { SpecField } from "@/lib/artifacts/artifact-types";

export type SpecCandidate =
  | { source: "marker"; loadBearing: boolean; text: string }
  | { source: "form"; fields: readonly SpecField[] };

/** True when a candidate becomes a spec artifact. */
export function isCapturedSpec(candidate: SpecCandidate): boolean {
  if (candidate.source === "marker") {
    return candidate.loadBearing && candidate.text.trim() !== "";
  }
  // A form submitted entirely blank states nothing — the tool result already
  // renders "(none given)" for each field, and that is not a requirement.
  return candidate.fields.some((field) => field.value.trim() !== "");
}
