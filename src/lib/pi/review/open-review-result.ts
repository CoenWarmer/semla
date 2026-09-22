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
import { isReviewCommentBody } from "@/lib/review/review-comment-types";
import type { ReviewComment } from "@/lib/review/review-comment-types";

export type { OpenReviewTarget };

/**
 * The router's usable outcomes: open at a target, or open with none, each
 * optionally carrying a comment the same call created.
 *
 * A comment never arrives without a target — open-review.ts's own
 * validation requires `path`+`line` before it will insert one — but the
 * type does not encode that, since this module's job is reading what the
 * tool actually returned, not re-deriving a constraint the tool already
 * enforced.
 */
export type OpenReviewOutcome =
  | { target: OpenReviewTarget; comment: ReviewComment | null; type: "open" }
  | { target: null; comment: ReviewComment | null; type: "open" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isTarget = (value: unknown): value is OpenReviewTarget =>
  isRecord(value) &&
  typeof value.project === "string" &&
  typeof value.path === "string" &&
  (value.line === undefined || typeof value.line === "number") &&
  (value.commitSha === undefined || typeof value.commitSha === "string");

const isComment = (value: unknown): value is ReviewComment =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.projectPath === "string" &&
  typeof value.filePath === "string" &&
  typeof value.startLine === "number" &&
  typeof value.endLine === "number" &&
  typeof value.createdAt === "string" &&
  isReviewCommentBody(value.body);

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

  // A malformed comment does not cost the target: it is dropped, the same
  // "cost a drawing, not the turn" tolerance the rest of this function
  // already applies to a malformed target.
  const rawComment = result.details.comment;
  const comment = isComment(rawComment) ? rawComment : null;

  const target = result.details.target;
  if (target === null) return { comment, target: null, type: "open" };
  if (isTarget(target)) return { comment, target, type: "open" };

  return null;
}
