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
 * `ResizeObserver` inside `ReviewCommentCard` reports the card's own real
 * height once React has painted it, and this class mutates `heightInPx` on
 * the same `IViewZone` object `_layoutZone` reads back from
 * (`viewZones.js`) and calls `accessor.layoutZone`, which is how Monaco's
 * own API expects a zone's height to change after creation.
 *
 * The observer watches the *card*, not the outer `domNode` the zone owns.
 * That distinction is load-bearing: Monaco sets `domNode`'s own
 * `style.height` to whatever `heightInPx` currently is (`viewZones.js`'s
 * `_addZone`/`_layoutZone`), so a `ResizeObserver` on `domNode` itself only
 * ever reports back the height this class just told Monaco to use — a
 * closed loop that converges on the provisional guess and never sees the
 * card's true, unconstrained content height. `overflow: visible` on the
 * host (globals.css) is what let the card visually spill past that wrong
 * height in the first place, reproducing the exact overlap this widget
 * exists to avoid, just one layer further down. The card's own div has no
 * height set by Monaco at all, so observing it directly reports the real
 * number.
 *
 * Rebuilt wholesale on every `set()`, same choice `review-access-label-widgets.tsx`
 * makes and for the same reason: few comments per file, no incremental
 * diffing worth the complexity yet. The one exception is a comment mid-way
 * through its dismiss animation (`animateDismiss` below) — `set()` checks
 * `shrinking` first and leaves that one zone alone rather than tearing it
 * down mid-shrink, which would cut the animation off and snap the code back
 * down. Once the animation finishes it calls the real `onDismiss`, whose
 * result is a `comments` list that no longer includes this one, and the
 * *next* `set()` simply omits it — the animation's job was only ever to
 * make removal look smooth, never to be the removal itself.
 *
 * Respects `prefers-reduced-motion`: `animateDismiss` checks the media query
 * on each call (not cached, since a user can change it while a session is
 * open) and jumps straight to zero when motion is reduced, still going
 * through the same completion path as an animated shrink.
 *
 * Model-per-file lifetime: "View zones are lost when a new model is
 * attached to the editor" (Monaco's own `changeViewZones` doc). `code-editor.tsx`
 * keeps one model per open path and calls `setModel` on every path switch,
 * so this class's `set()` is invoked again whenever `path` changes (see its
 * effect's dependency array) — a zone lost on switch is simply redrawn
 * against the model just attached, not a leak.
 */

import { XIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";

import { Button } from "@/components/ui/button";

import { monaco } from "./monaco-setup";
import { ReviewCommentBodyView } from "./review-comment-body";
import type { ReviewComment } from "@/lib/review/review-comment-types";

/**
 * One comment's own explanation, plus a dismiss control.
 *
 * `onHeightChange` fires with the card's own real rendered height — via a
 * `ResizeObserver` on this component's own root node, not on the view
 * zone's outer `domNode` the class owns. See the module docblock for why
 * that distinction is the whole fix: `domNode` is height-constrained by
 * Monaco itself, and this element is not.
 */
function ReviewCommentCard({
  comment,
  onDismiss,
  onHeightChange,
}: {
  comment: ReviewComment;
  onDismiss: () => void;
  onHeightChange: (height: number) => void;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = cardRef.current;
    if (!node) return;

    // Fired once on `observe()` with the current size, and again on every
    // real change — an image loading, a window resize, a markdown edit —
    // so the zone stays honest for the card's whole lifetime, not only at
    // first paint.
    //
    // Read from `node.offsetHeight` on the callback tick, not from the
    // observer entry's own `contentRect`: `contentRect` is the *content*
    // box, excluding this element's own border and padding
    // (`.semla-review-comment`'s 1px border and 6px top/bottom padding),
    // which under-reports the card's real occupied height by exactly that
    // amount — confirmed against the live DOM, where it left an ~18px gap
    // between the reserved zone and the card's actual bottom edge.
    // `offsetHeight` is the border-box, which is what the zone needs to
    // reserve.
    const observer = new ResizeObserver(() => {
      onHeightChange(node.offsetHeight);
    });
    observer.observe(node);
    return () => observer.disconnect();
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const range =
    comment.startLine === comment.endLine
      ? `Line ${comment.startLine}`
      : `Lines ${comment.startLine}–${comment.endLine}`;

  return (
    <div className="semla-review-comment" ref={cardRef}>
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
  domNode: HTMLDivElement;
}

/** How long the dismiss shrink takes, matched to the card's own fade in CSS. */
const DISMISS_DURATION_MS = 180;

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Ease-out cubic. A shrink reads as more natural decelerating into the
 * collapse than at a constant rate — the same easing shape
 * `.semla-following-pulse` computes at a different frequency for a
 * different purpose.
 */
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

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
  /**
   * Comments currently shrinking toward removal, by id. Consulted at the
   * top of `set()` so a rebuild triggered by something unrelated — the
   * scrubber moving, a sibling comment arriving — does not cut an
   * in-progress dismiss animation short. Cleared once the animation calls
   * through to the real `onDismiss`.
   */
  private shrinking = new Set<string>();

  constructor(
    editor: monaco.editor.IStandaloneCodeEditor,
    onDismiss: (id: string) => void,
  ) {
    this.editor = editor;
    this.onDismiss = onDismiss;
  }

  /**
   * Shrink one comment's zone to nothing, fading its card, then call
   * through to the real dismiss.
   *
   * Reduced-motion and the animated path both end the same way — a final
   * `heightInPx = 0` / `layoutZone` and then `this.onDismiss(id)` — so a
   * test or a future caller never has to know which path ran.
   */
  private animateDismiss(id: string) {
    const state = this.states.get(id);
    if (!state) return;

    this.shrinking.add(id);
    state.domNode.style.opacity = "0";
    state.domNode.style.transition = `opacity ${DISMISS_DURATION_MS}ms ease-out`;

    const startHeight = state.zone.heightInPx ?? 0;
    if (startHeight <= 0 || prefersReducedMotion()) {
      this.shrinking.delete(id);
      this.onDismiss(id);
      return;
    }

    const startTime = performance.now();
    const step = () => {
      // The comment may have been dismissed a second time, or the widget
      // disposed, while a frame was in flight — `states` no longer having
      // this id either way is the signal to stop stepping.
      if (!this.states.has(id)) return;

      const elapsed = performance.now() - startTime;
      const progress = Math.min(1, elapsed / DISMISS_DURATION_MS);
      const height = startHeight * (1 - easeOutCubic(progress));

      state.zone.heightInPx = height;
      this.editor.changeViewZones((accessor) => {
        accessor.layoutZone(state.zoneId);
      });

      if (progress < 1) {
        requestAnimationFrame(step);
        return;
      }

      this.shrinking.delete(id);
      this.onDismiss(id);
    };
    requestAnimationFrame(step);
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
        // Left exactly as the running animation last set it — `clear()`
        // (just above, this same call) already skipped removing this
        // zone for the same reason. A comment stays in `comments` for
        // the whole shrink, since the real removal (`this.onDismiss`)
        // only fires once the animation finishes.
        if (this.shrinking.has(comment.id)) continue;

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
            onDismiss={() => this.animateDismiss(comment.id)}
            onHeightChange={(measured) => {
              if (Math.abs(measured - zone.heightInPx!) < 1) return;
              zone.heightInPx = measured;
              this.editor.changeViewZones((innerAccessor) => {
                innerAccessor.layoutZone(zoneId);
              });
            }}
          />,
        );

        this.states.set(comment.id, { domNode, root, zone, zoneId });
      }
    });
  }

  /**
   * Tear down every zone except one mid-shrink (`this.shrinking`), which is
   * left completely alone — its `domNode`, its `zone` object, its entry in
   * `this.states` — so the running `requestAnimationFrame` loop in
   * `animateDismiss` keeps driving the exact zone Monaco already has.
   * Removing it here and `set()` recreating a fresh one a moment later
   * would restart the shrink from `PROVISIONAL_HEIGHT_PX`, not from wherever
   * the animation actually was.
   */
  private clear() {
    const toRemove = [...this.states.entries()].filter(
      ([id]) => !this.shrinking.has(id),
    );
    if (toRemove.length === 0) return;

    this.editor.changeViewZones((accessor) => {
      for (const [, state] of toRemove) {
        accessor.removeZone(state.zoneId);
      }
    });
    for (const [id, state] of toRemove) {
      // Deferred for the reason review-hunk-bracket-widgets.tsx gives:
      // unmounting synchronously while React is rendering warns, and Monaco
      // has already let go of the node.
      setTimeout(() => state.root.unmount(), 0);
      this.states.delete(id);
    }
  }

  dispose() {
    // The widget itself is going away, so nothing is served by finishing an
    // in-progress shrink — forget it rather than let `clear()` preserve it
    // for an animation loop that would otherwise keep calling
    // `changeViewZones` on an editor about to be disposed.
    this.shrinking.clear();
    this.clear();
  }
}
