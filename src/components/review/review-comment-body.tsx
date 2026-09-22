"use client";

/**
 * The closed set of `ReviewCommentBody` kinds, rendered.
 *
 * See review-comment-types.ts's docblock for why this is a switch over a
 * closed union and not a registry: v1 has exactly two kinds, and a third is
 * one more `case` here, not a new mechanism.
 */

import { Streamdown } from "streamdown";

import type { ReviewCommentBody } from "@/lib/review/review-comment-types";

export function ReviewCommentBodyView({ body }: { body: ReviewCommentBody }) {
  if (body.kind === "markdown") {
    return (
      <div className="semla-review-comment-markdown text-sm">
        <Streamdown className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
          {body.markdown}
        </Streamdown>
      </div>
    );
  }

  // "text": shown verbatim, no markdown parsing. `whitespace-pre-wrap`
  // rather than a `<pre>` — this is prose, not code, and a monospace block
  // would visually clash with the comment's own explanatory tone.
  return <p className="whitespace-pre-wrap text-sm">{body.text}</p>;
}
