/**
 * Reads the created comments back out of a `place_review_comments` tool
 * result.
 *
 * Same boundary as `open-review-result.ts`'s `readOpenReviewResult`: the
 * result crosses from a jiti-loaded extension into `unknown`, so it is
 * validated here rather than cast. Only the successful entries are
 * extracted — a failed entry has no `ReviewComment` to give the panel, and
 * the tool's own text content already told the agent which indexes failed
 * and why, which is a model-facing concern this reader has no reason to
 * duplicate.
 */

import { isReviewCommentBody } from "@/lib/review/review-comment-types";
import type { ReviewComment } from "@/lib/review/review-comment-types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
 * Every comment this call actually created, in request order. `null` means
 * "not this tool, or malformed" — the router does not emit for that; an
 * empty array is a real, distinct outcome ("this tool ran, but every entry
 * failed to resolve").
 */
export function readPlaceReviewCommentsResult(
  result: unknown,
): readonly ReviewComment[] | null {
  if (!isRecord(result) || !isRecord(result.details)) return null;
  if (result.details.type !== "place-review-comments") return null;

  const results = result.details.results;
  if (!Array.isArray(results)) return null;

  const comments: ReviewComment[] = [];
  for (const entry of results) {
    if (!isRecord(entry) || entry.ok !== true) continue;
    if (isComment(entry.comment)) comments.push(entry.comment);
  }
  return comments;
}
