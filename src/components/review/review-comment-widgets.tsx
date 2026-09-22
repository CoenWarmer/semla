/**
 * Agent-authored comments, drawn as real space reserved above the range of
 * code they explain.
 *
 * A Monaco *view zone* (`changeViewZones`/`IViewZone`), not a content widget
 * like `review-access-label-widgets.tsx` uses. That was tried first and
 * rejected on sight: a content widget floats *over* the editor and never
 * reserves space, which is the right trade for a one-line, semi-transparent
 * access-label chip but the wrong one for a comment card tall enough to
 * cover several lines of the code underneath it — which is what happened
 * (see the operator's own report against the first build). A view zone
 * inserts real blank space in the document flow at `afterLineNumber` and
 * pushes every line below it down, so the card never overlaps a line of
 * code at all.
 *
 * The cost of that correctness: the file visibly reflows every time a
 * comment appears, is dismissed, or changes height (its markdown can arrive
 * with images or long lines whose rendered height is not known until React
 * has painted it) — a decoration or a content widget never does this by
 * design, and nothing else in this editor moves lines around under the
 * operator's cursor. Accepted because covering code is worse: a comment
 * that hides the very thing it explains is the one failure mode this widget
 * exists to avoid.
 *
 * Height is not knowable up front the way a hunk bracket's is
 * (`hunkBracketLineCount` — a hunk's line span is arithmetic over line
 * numbers). Markdown's rendered height depends on the browser's layout of
 * arbitrary prose, so each zone is created at a provisional height, then a
 * `ResizeObserver` on its own dom node calls `accessor.layoutZone` once
 * React has actually painted — mutating `heightInPx` on the same `IViewZone`
 * object `_layoutZone` reads back from (`viewZones.js`), which is how
 * Monaco's own API expects a zone's height to change after creation.
 *
 * Rebuilt wholesale on every `set()`, same choice `review-access-label-widgets.tsx`
 * makes and for the same reason: few comments per file, no incremental
 * diffing worth the complexity yet.
 *
 * Model-per-file lifetime: "View zones are lost when a new model is
 * attached to the editor" (Monaco's own `changeViewZones` doc). `code-editor.tsx`
 * keeps one model per open path and calls `setModel` on every path switch,
 * so this class's `set()` is invoked again whenever `path` changes (see its
 * effect's dependency array) — a zone lost on switch is simply redrawn
 * against the model just attached, not a leak.
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
  zoneId: string;
  zone: monaco.editor.IViewZone;
  root: Root;
  resizeObserver: ResizeObserver;
  domNode: HTMLDivElement;
}

/**
 * A reasonable first guess at a card's height, in pixels, before its real
 * content has painted. Deliberately generous — an initial guess that is too
 * short reflows the file a second time the instant the `ResizeObserver`
 * fires, which is more visually disruptive than reflowing once, slightly
 * too far.
 */
const PROVISIONAL_HEIGHT_PX = 72;

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
   * version of the file must not anchor a zone off the end of the model.
   *
   * Anchored at `startLine - 1`: a view zone's `afterLineNumber` places it
   * *after* the given line, and `0` is Monaco's own convention for "before
   * the first line" — so `clamp(comment.startLine) - 1` lands the zone
   * immediately above the comment's own first line for every case,
   * including a comment on line 1.
   */
  set(comments: readonly ReviewComment[], lineCount: number) {
    this.clear();

    const clamp = (line: number) => Math.min(Math.max(1, line), Math.max(1, lineCount));

    this.editor.changeViewZones((accessor) => {
      for (const comment of comments) {
        const domNode = document.createElement("div");
        domNode.className = "semla-review-comment-host";

        const startLine = clamp(comment.startLine);
        const endLine = Math.max(startLine, clamp(comment.endLine));
        const resolvedComment = { ...comment, endLine, startLine };

        const zone: monaco.editor.IViewZone = {
          afterLineNumber: startLine - 1,
          domNode,
          heightInPx: PROVISIONAL_HEIGHT_PX,
          suppressMouseDown: false,
        };
        const zoneId = accessor.addZone(zone);

        const root = createRoot(domNode);
        root.render(
          <ReviewCommentCard
            comment={resolvedComment}
            onDismiss={() => this.onDismiss(comment.id)}
          />,
        );

        // The card's real height is whatever the browser lays React's
        // markdown out to, not something computable from the comment's own
        // data — unlike the hunk bracket, which only ever needs arithmetic
        // over line numbers. Observed rather than measured once: an image
        // loading, a window resize, or a markdown edit can all change it
        // after this first paint.
        const resizeObserver = new ResizeObserver((entries) => {
          const measured = entries[0]?.contentRect.height;
          if (!measured || Math.abs(measured - zone.heightInPx!) < 1) return;
          zone.heightInPx = measured;
          this.editor.changeViewZones((innerAccessor) => {
            innerAccessor.layoutZone(zoneId);
          });
        });
        resizeObserver.observe(domNode);

        this.states.set(comment.id, { domNode, resizeObserver, root, zone, zoneId });
      }
    });
  }

  private clear() {
    if (this.states.size === 0) return;

    const states = [...this.states.values()];
    this.editor.changeViewZones((accessor) => {
      for (const state of states) {
        state.resizeObserver.disconnect();
        accessor.removeZone(state.zoneId);
      }
    });
    for (const state of states) {
      // Deferred for the reason review-hunk-bracket-widgets.tsx gives:
      // unmounting synchronously while React is rendering warns, and Monaco
      // has already let go of the node.
      setTimeout(() => state.root.unmount(), 0);
    }
    this.states = new Map();
  }

  dispose() {
    this.clear();
  }
}
