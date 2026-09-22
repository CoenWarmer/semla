/**
 * Agent-authored comments, drawn above the range of code they explain.
 *
 * Follows `review-access-label-widgets.tsx` exactly: an `IContentWidget`
 * (`addContentWidget`/`removeContentWidget`), `ContentWidgetPositionPreference.ABOVE`
 * with a `BELOW` fallback for a comment anchored at line 1, `allowEditorOverflow`
 * for the same reason, `suppressMouseDown` so a click on the widget's chrome
 * does not move the text cursor underneath — except here `suppressMouseDown`
 * only needs to cover the widget's own header, because unlike an access
 * label a comment is meant to be read and its dismiss control clicked, not
 * merely glanced at.
 *
 * Monaco positions the outer node and nothing else (`contentWidgets.js`'s
 * `_renderWidget` sets `style.position/top/left`), so a React root mounted
 * inside is safe on the same grounds `review-access-label-widgets.tsx`
 * establishes.
 *
 * Rebuilt wholesale on every `set()` — a comment's key is its own id, which
 * *is* stable across calls (unlike a hunk's position-derived key), but there
 * is nothing yet worth diffing incrementally for: comments are few per file
 * and `createRoot`+`render` on a handful of nodes is not a cost worth a
 * reconciliation scheme.
 */

import { XIcon } from "lucide-react";
import { createRoot, type Root } from "react-dom/client";

import { Button } from "@/components/ui/button";

import { monaco } from "./monaco-setup";
import { ReviewCommentBodyView } from "./review-comment-body";
import type { ReviewComment } from "@/lib/review/review-comment-types";

/** One comment's own explanation, plus a dismiss control. */
function ReviewCommentCard({
  comment,
  onDismiss,
}: {
  comment: ReviewComment;
  onDismiss: () => void;
}) {
  const range =
    comment.startLine === comment.endLine
      ? `Line ${comment.startLine}`
      : `Lines ${comment.startLine}–${comment.endLine}`;

  return (
    <div className="semla-review-comment">
      <div className="semla-review-comment-header">
        <span className="semla-review-comment-kicker">Agent · {range}</span>
        <Button
          aria-label="Dismiss comment"
          className="semla-review-comment-dismiss pointer-events-auto"
          onClick={(event) => {
            event.stopPropagation();
            onDismiss();
          }}
          onMouseDown={(event) => {
            event.stopPropagation();
          }}
          size="icon-xs"
          title="Dismiss"
          type="button"
          variant="ghost"
        >
          <XIcon />
        </Button>
      </div>
      <ReviewCommentBodyView body={comment.body} />
    </div>
  );
}

interface CommentState {
  widget: monaco.editor.IContentWidget;
  root: Root;
  comment: ReviewComment;
}

export class ReviewCommentWidgets {
  private readonly editor: monaco.editor.IStandaloneCodeEditor;
  private states = new Map<string, CommentState>();
  private onDismiss: (id: string) => void;

  constructor(
    editor: monaco.editor.IStandaloneCodeEditor,
    onDismiss: (id: string) => void,
  ) {
    this.editor = editor;
    this.onDismiss = onDismiss;
  }

  /**
   * Replace every drawn comment with `comments`.
   *
   * `lineCount` is the model's current line count, for the same clamp
   * `buildAccessLabels` applies: a comment recorded against a longer past
   * version of the file must not anchor a widget off the end of the model,
   * which Monaco would throw on.
   */
  set(comments: readonly ReviewComment[], lineCount: number) {
    this.clear();

    const clamp = (line: number) => Math.min(Math.max(1, line), Math.max(1, lineCount));

    for (const comment of comments) {
      const domNode = document.createElement("div");
      domNode.className = "semla-review-comment-host";

      const startLine = clamp(comment.startLine);
      const endLine = Math.max(startLine, clamp(comment.endLine));

      const widget: monaco.editor.IContentWidget = {
        allowEditorOverflow: true,
        getDomNode: () => domNode,
        getId: () => `semla-review-comment-${comment.id}`,
        getPosition: () => ({
          position: { column: 1, lineNumber: startLine },
          preference: [
            monaco.editor.ContentWidgetPositionPreference.ABOVE,
            monaco.editor.ContentWidgetPositionPreference.BELOW,
          ],
        }),
        suppressMouseDown: true,
      };

      const root = createRoot(domNode);
      const state: CommentState = { comment: { ...comment, endLine, startLine }, root, widget };
      root.render(
        <ReviewCommentCard
          comment={state.comment}
          onDismiss={() => this.onDismiss(comment.id)}
        />,
      );

      this.editor.addContentWidget(widget);
      this.states.set(comment.id, state);
    }
  }

  private clear() {
    for (const state of this.states.values()) {
      const { root } = state;
      this.editor.removeContentWidget(state.widget);
      // Deferred for the reason review-hunk-bracket-widgets.tsx gives:
      // unmounting synchronously while React is rendering warns, and Monaco
      // has already let go of the node.
      setTimeout(() => root.unmount(), 0);
    }
    this.states = new Map();
  }

  dispose() {
    this.clear();
  }
}
