/**
 * Postgres-backed storage for agent-authored review comments.
 *
 * Unlike session_artifacts (disk-authoritative, Postgres a mirror — see
 * artifact-persistence.ts's own docblock), there is no on-disk copy of a
 * comment: nothing captures it from the git tree, and disk-authoritative
 * only matters where a snapshot has to survive a lost database write and be
 * re-derived. A comment is created once, by one tool call, with nothing to
 * re-derive it from — so Postgres is the only copy, the same way
 * session_projects' *links* are not (that one has a disk mirror precisely
 * because it can be reconstructed; this cannot).
 *
 * Every function here throws on failure, matching session-persistence.ts's
 * own convention. `createReviewComment` is called from open-review.ts's
 * `execute`, which is itself the tool's synchronous return path — a comment
 * that silently failed to save would tell the operator it exists (via the
 * tool's own success text) while nothing durable backs it, so this is
 * deliberately *not* detached the way `captureAndRecord` is.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { describeDbError } from "@/lib/pi/session/session-persistence";
import { isReviewCommentBody } from "@/lib/review/review-comment-types";
import type {
  ReviewComment,
  ReviewCommentBody,
} from "@/lib/review/review-comment-types";

export interface NewReviewComment {
  sessionId: string;
  projectPath: string;
  filePath: string;
  startLine: number;
  endLine: number;
  body: ReviewCommentBody;
  toolCallId: string | null;
}

function fromRow(row: {
  id: string;
  project_path: string;
  file_path: string;
  start_line: number;
  end_line: number;
  body: unknown;
  created_at: string;
}): ReviewComment | null {
  if (!isReviewCommentBody(row.body)) return null;
  return {
    body: row.body,
    createdAt: row.created_at,
    endLine: row.end_line,
    filePath: row.file_path,
    id: row.id,
    projectPath: row.project_path,
    startLine: row.start_line,
  };
}

/**
 * Insert one comment and return it as the panel will read it back.
 *
 * `endLine < startLine` is a caller error — the tool's own schema validates
 * this before calling here (see open-review.ts) — so it is not re-checked;
 * the database's own `review_comments_line_range` check constraint is the
 * backstop, and its failure surfaces as the generic error below rather than
 * a friendlier message, because a caller that already validated should
 * never reach it.
 */
export async function createReviewComment(
  input: NewReviewComment,
): Promise<ReviewComment> {
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("review_comments")
    .insert({
      body: input.body,
      end_line: input.endLine,
      file_path: input.filePath,
      project_path: input.projectPath,
      session_id: input.sessionId,
      start_line: input.startLine,
      tool_call_id: input.toolCallId,
    })
    .select("id, project_path, file_path, start_line, end_line, body, created_at")
    .single();

  if (error || !data) {
    throw new Error(
      `Unable to save the review comment: ${describeDbError(error?.message ?? "no row returned")}`,
    );
  }

  const comment = fromRow(data);
  if (!comment) {
    // The row was just inserted with a body this same module serialised, so
    // a malformed read back is a bug here, not a caller error — thrown
    // rather than swallowed so it surfaces immediately rather than as a
    // silently missing widget three steps downstream.
    throw new Error("Inserted review comment does not round-trip as a valid body.");
  }
  return comment;
}

/**
 * Every live (non-dismissed) comment for one file, oldest first.
 *
 * Oldest first because a comment's position in the editor is unrelated to
 * when it was created, and the caller (ReviewEditorPane) does not care about
 * order beyond "stable" — but a fixed order is worth having rather than
 * whatever Postgres happens to return.
 */
export async function listReviewComments(
  sessionId: string,
  projectPath: string,
  filePath: string,
): Promise<ReviewComment[]> {
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("review_comments")
    .select("id, project_path, file_path, start_line, end_line, body, created_at")
    .eq("session_id", sessionId)
    .eq("project_path", projectPath)
    .eq("file_path", filePath)
    .is("dismissed_at", null)
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`Unable to read review comments: ${describeDbError(error.message)}`);
  }

  const comments: ReviewComment[] = [];
  for (const row of data ?? []) {
    const comment = fromRow(row);
    // A row whose body no longer validates (a future migration narrowed the
    // union, a hand-edited row) costs that one comment, not the whole list —
    // the same tolerance readSessionArtifacts' parseTail applies to an
    // unparsable line.
    if (comment) comments.push(comment);
  }
  return comments;
}

/**
 * Every live comment of the whole session, across every file and project,
 * oldest first.
 *
 * A second reader beside `listReviewComments` rather than a parameter on it,
 * because the two answer different questions and are cached differently: the
 * per-file list is what a file's own editor pane draws, and this one is the
 * *order* the comment cards' navigation arrows step through. Oldest first is
 * load-bearing here in a way it is not for one file — it is the sequence the
 * agent created the comments in, which for a walkthrough is the sequence the
 * explanation was meant to be read in.
 */
export async function listAllReviewComments(
  sessionId: string,
): Promise<ReviewComment[]> {
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("review_comments")
    .select("id, project_path, file_path, start_line, end_line, body, created_at")
    .eq("session_id", sessionId)
    .is("dismissed_at", null)
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`Unable to read review comments: ${describeDbError(error.message)}`);
  }

  const comments: ReviewComment[] = [];
  for (const row of data ?? []) {
    const comment = fromRow(row);
    // Same tolerance `listReviewComments` applies: a row whose body no longer
    // validates costs that one comment, not the whole sequence.
    if (comment) comments.push(comment);
  }
  return comments;
}

/**
 * Hide one comment from the panel without deleting the record.
 *
 * Scoped by `sessionId` as well as `id` — the id is a random uuid so a
 * cross-session guess is not realistically reachable, but the route this
 * backs takes the id from the URL and the session from the path, and
 * matching both is what makes "dismiss" incapable of touching a comment on
 * a different session even if it somehow guessed right.
 */
export async function dismissReviewComment(
  sessionId: string,
  commentId: string,
): Promise<void> {
  const admin = createAdminClient();

  const { error } = await admin
    .from("review_comments")
    .update({ dismissed_at: new Date().toISOString() })
    .eq("id", commentId)
    .eq("session_id", sessionId);

  if (error) {
    throw new Error(`Unable to dismiss the review comment: ${describeDbError(error.message)}`);
  }
}
