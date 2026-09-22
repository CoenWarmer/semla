/**
 * The body of an agent-authored comment shown in the review editor.
 *
 * A closed union, not a registry. An agent's tool call carries structured
 * arguments, never literal JSX — so "any React component" (docs/plans/review-comments.md
 * §1) means a fixed, closed set of kinds, each with a typed payload the
 * corresponding component in review-comment-body.tsx renders. v1 ships
 * `text` and `markdown` only. Do not generalise this into a plugin system
 * before a second real kind exists to justify it — the closed set is the
 * design, not a placeholder for one.
 *
 * Node-free, mirroring review-types.ts: this is imported from client
 * components, and client-boundary.test.ts fails the whole page compile with
 * an unrelated-looking ENOENT if a client component reaches a module that
 * imports `node:fs` transitively.
 */
export type ReviewCommentBody =
  | { kind: "text"; text: string }
  | { kind: "markdown"; markdown: string };

/** A stored comment, as the panel reads it back — one file, one range. */
export interface ReviewComment {
  id: string;
  projectPath: string;
  filePath: string;
  /** 1-based, inclusive. */
  startLine: number;
  /** 1-based, inclusive. Equal to startLine for a single-line comment. */
  endLine: number;
  body: ReviewCommentBody;
  createdAt: string;
}

/**
 * A structurally valid `ReviewCommentBody`, or null.
 *
 * Used at every boundary a comment crosses that this module does not fully
 * control the origin of: the tool's own arguments, and a jsonb column read
 * back from Postgres. Neither is a `ReviewCommentBody` until this says so.
 */
export function isReviewCommentBody(value: unknown): value is ReviewCommentBody {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;

  if (record.kind === "text") return typeof record.text === "string";
  if (record.kind === "markdown") return typeof record.markdown === "string";
  return false;
}
