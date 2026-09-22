/**
 * Reads an `OpenReviewTarget` back out of an `open_review` tool result.
 *
 * Same boundary as tool-result.ts's `readCodeMapResult`: the result crosses
 * from a jiti-loaded extension into `unknown`, so it is validated here rather
 * than cast. Three outcomes, not two, because "no usable result" (a
 * malformed or unrelated tool result) and "open with no target" (a validated
 * `open_review` call the model made with no path) are different things the
 * router needs to tell apart — the first should not open anything, the
 * second should open the panel with nothing selected.
 */

import type { OpenReviewTarget } from "@/lib/pi/extensions/open-review";

export type { OpenReviewTarget };

/** The router's usable outcomes: open at a target, or open with none. */
export type OpenReviewOutcome =
  | { target: OpenReviewTarget; type: "open" }
  | { target: null; type: "open" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isTarget = (value: unknown): value is OpenReviewTarget =>
  isRecord(value) &&
  typeof value.project === "string" &&
  typeof value.path === "string" &&
  (value.line === undefined || typeof value.line === "number") &&
  (value.commitSha === undefined || typeof value.commitSha === "string");

/**
 * Pull the target out of an `open_review` tool result, if there is a usable
 * one. Null means "not this tool, or malformed" — the router does not emit
 * for that. A malformed `details.target` (present but not `null` and not a
 * valid target) is treated the same as absent, for the reason
 * `readCodeMapResult` gives: a tool result that cannot be read should cost
 * the panel a drawing, not the turn.
 */
export function readOpenReviewResult(result: unknown): OpenReviewOutcome | null {
  if (!isRecord(result) || !isRecord(result.details)) return null;
  if (result.details.type !== "open-review") return null;

  const target = result.details.target;
  if (target === null) return { target: null, type: "open" };
  if (isTarget(target)) return { target, type: "open" };

  return null;
}
