/**
 * Turning a clicked artifact chip into an `ElementTarget` request.
 *
 * Pure, and split out of `sessions-list-client.tsx` for the same reason
 * `review-panel-request.ts`'s derivations are pure: it is the part worth
 * testing precisely, and this repo runs no jsdom to render the click itself
 * through. The nonce is deliberately absent from the return type — it is
 * `ElementTargetStore.request`'s job to assign one, same as every other
 * producer of a target.
 */

import type { ElementTarget } from "@/components/element-target-provider";
import type { ArtifactChip } from "@/lib/artifacts/artifact-summary";

/**
 * The request for `chip`, or null when the chip addresses nothing to open.
 *
 * A `pr` chip's target is always null — it opens its own url instead, and
 * the caller must check `chip.kind` before this is ever reached (see
 * `ArtifactChipButton`, which renders a pr chip as a plain link). An
 * informational chip (`target: null`, e.g. a commit with no files) also
 * yields null here: there is nothing for the panel to select.
 */
export function artifactTargetFor(
  chip: ArtifactChip,
): Omit<ElementTarget, "nonce"> | null {
  // Spelled out rather than falling through `!target`: a spec chip's
  // `target` is already null, so this branch changes nothing at runtime.
  // It exists so the reason is legible here rather than only in
  // ElementTarget's shape — reusing ElementTarget for a spec would mean
  // inventing a code location (a file, a line) that no requirement has.
  if (chip.kind === "spec") return null;

  const { target } = chip;
  if (!target) return null;

  return {
    anchor: target.anchor,
    commitSha: target.commitSha,
    // undefined, not null: "open this file" rather than "scroll to line 1",
    // the same distinction ElementTarget.line's own doc comment explains.
    line: target.anchor?.newStart ?? undefined,
    path: target.path,
    precision: "exact",
    project: target.project,
  };
}
