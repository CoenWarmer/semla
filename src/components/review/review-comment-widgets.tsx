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
 *
 * A comment optionally carries a "Stage this hunk"/"Unstage this hunk"
 * control in its header, next to the dismiss `×` — present only when the
 * comment's own line range names exactly one hunk (`matchCommentHunk` in
 * `review-hunk-match.ts`, the same range-equality domain `matchHunkAction`
 * already uses for the gutter's hunk-bracket button). A comment about a
 * range that is not a hunk at all, or that only partially overlaps one, gets
 * no button — same reasoning `matchHunkAction`'s own docblock gives for
 * refusing a partial match rather than guessing. Clicking it calls straight
 * through to the same `onStageHunk` plumbing `HunkBracketWidgets` uses, so
 * the two controls behave identically and share the one `stagingBusy` flag
 * that disables both while a stage request is in flight.
 */

import {
  ChevronLeftIcon,
  ChevronRightIcon,
  MinusIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";

import { Button } from "@/components/ui/button";

import { monaco } from "./monaco-setup";
import { ReviewCommentBodyView } from "./review-comment-body";
import { matchCommentHunk, type HunkAction } from "./review-hunk-match";
import type { FileDiff, Hunk } from "@/lib/review/review-types";
import type { ReviewComment } from "@/lib/review/review-comment-types";

/**
 * Where one comment sits in the session's whole comment sequence, for the
 * card's own navigation footer.
 *
 * A position rather than two booleans, so the footer can also say "3 of 8":
 * an arrow that is simply disabled tells the operator they have reached an
 * end, but not how far through the walkthrough they are.
 */
export interface CommentNavigation {
  /** One-based position in the session's comment sequence. */
  position: number;
  total: number;
  /** Open the comment before/after this one. Absent at either end. */
  onPrevious?: () => void;
  onNext?: () => void;
}

/**
 * One comment's own explanation, a dismiss control, and — when the session
 * has more than one comment — a footer that steps to the next or previous
 * one.
 *
 * The footer is the card's own, rather than a control in the panel chrome,
 * because the thing being stepped through is the card: the operator is
 * reading an explanation and wants the next explanation, which may well be
 * in another file. The panel's existing `d`/`a` keys step diff *hunks*,
 * which is a different sequence with a different purpose — see
 * review-hunk-cursor.ts.
 *
 * `onHeightChange` fires with the card's own real rendered height — via a
 * `ResizeObserver` on this component's own root node, not on the view
 * zone's outer `domNode` the class owns. See the module docblock for why
 * that distinction is the whole fix: `domNode` is height-constrained by
 * Monaco itself, and this element is not.
 */
function ReviewCommentCard({
  comment,
  navigation,
  onDismiss,
  onHeightChange,
  onStage,
  stageAction,
  stageBusy,
}: {
  comment: ReviewComment;
  navigation: CommentNavigation | null;
  onDismiss: () => void;
  onHeightChange: (height: number) => void;
  /** Present only when this comment's range names exactly one hunk. */
  stageAction: HunkAction | null;
  onStage: () => void;
  stageBusy: boolean;
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
        <div className="flex items-center gap-1">
          {stageAction ? (
            <Button
              aria-label={
                stageAction.direction === "stage"
                  ? "Stage this hunk"
                  : "Unstage this hunk"
              }
              className="semla-review-comment-stage pointer-events-auto"
              disabled={stageBusy}
              onClick={(event) => {
                event.stopPropagation();
                onStage();
              }}
              onMouseDown={(event) => {
                event.stopPropagation();
              }}
              size="icon-xs"
              title={
                stageAction.direction === "stage"
                  ? "Stage this hunk"
                  : "Unstage this hunk"
              }
              type="button"
              variant="ghost"
            >
              {stageAction.direction === "stage" ? <PlusIcon /> : <MinusIcon />}
            </Button>
          ) : null}
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
      </div>
      <ReviewCommentBodyView body={comment.body} />
      {navigation && navigation.total > 1 ? (
        <div className="semla-review-comment-footer">
          <Button
            aria-label="Previous comment"
            className="semla-review-comment-nav pointer-events-auto"
            disabled={!navigation.onPrevious}
            onClick={(event) => {
              event.stopPropagation();
              navigation.onPrevious?.();
            }}
            // Monaco listens for mousedown on the editor underneath this
            // zone, and would move the text cursor before the click lands —
            // the same reason the dismiss button above stops it.
            onMouseDown={(event) => {
              event.stopPropagation();
            }}
            size="icon-xs"
            title="Previous comment"
            type="button"
            variant="ghost"
          >
            <ChevronLeftIcon />
          </Button>
          <span className="semla-review-comment-count">
            {navigation.position} of {navigation.total}
          </span>
          <Button
            aria-label="Next comment"
            className="semla-review-comment-nav pointer-events-auto"
            disabled={!navigation.onNext}
            onClick={(event) => {
              event.stopPropagation();
              navigation.onNext?.();
            }}
            onMouseDown={(event) => {
              event.stopPropagation();
            }}
            size="icon-xs"
            title="Next comment"
            type="button"
            variant="ghost"
          >
            <ChevronRightIcon />
          </Button>
        </div>
      ) : null}
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

/**
 * Everything the widget needs to draw a card's navigation footer: the
 * session's whole comment sequence, and how to go to one of them.
 *
 * Passed in rather than fetched here — this class has no access to react-query
 * and, more importantly, opening a comment in *another* file is the panel's
 * job, not the editor's. See `ReviewEditorPane`'s `commentNavigation` prop.
 */
export interface CommentSequence {
  /** Every live comment of the session, in creation order. */
  ordered: readonly ReviewComment[];
  /** Open a comment: switch file if needed, and reveal its first line. */
  goTo: (comment: ReviewComment) => void;
}

export class ReviewCommentWidgets {
  private readonly editor: monaco.editor.IStandaloneCodeEditor;
  private states = new Map<string, CommentState>();
  private onDismiss: (id: string) => void;
  private onStage: (index: number, direction: HunkAction["direction"]) => void;
  private sequence: CommentSequence | null = null;
  /**
   * What is and is not staged, and the full diff's own hunks — everything
   * `matchCommentHunk` needs to decide whether a comment's range names one
   * hunk. Set on every `set()` call, same lifetime as `comments` itself:
   * staging state changes on its own schedule (a click elsewhere in this
   * same file, a refetch) and `set()` is the one place already rebuilding
   * every card, so there is nowhere cheaper to react to it.
   */
  private hunks: readonly Hunk[] = [];
  private staging: { staged: FileDiff | null; unstaged: FileDiff | null } | null =
    null;
  private stagingBusy = false;
  /**
   * Comments currently shrinking toward removal, by id. Consulted at the
   * top of `set()` so a rebuild triggered by something unrelated — the
   * scrubber moving, a sibling comment arriving — does not cut an
   * in-progress dismiss animation short. Cleared once the animation calls
   * through to the real `onDismiss`.
   */
  private shrinking = new Set<string>();
  /**
   * Keeps every open host's `max-width` equal to the editor's own visible
   * content width.
   *
   * Monaco's `viewZones.js` sets a zone's outer node to `width: 100%`
   * unconditionally (`_addZone`), and that percentage resolves against
   * `.view-zones`'s own width — which Monaco sizes to the *content* width of
   * the widest line in the file (`viewLayout`'s `getScrollWidth()`), not the
   * editor's visible viewport. A file with one long line therefore makes
   * every comment host — and the card inside it — as wide as that line,
   * however far that reaches past the editor's own right edge; this was the
   * cause of the operator's report that a comment overflowed out of the
   * editor. `getLayoutInfo().contentWidth` is the viewport width Monaco
   * actually renders and scrolls, the same quantity `HunkBracketWidgets`
   * reads from `onDidLayoutChange` to track viewport-relative geometry, so
   * it is applied here as a `max-width` clamp rather than a fixed `width`:
   * a narrower file must still let the host shrink to `100%` as it always
   * has, only a wider one needs clamping.
   */
  private readonly layoutSubscription: ReturnType<
    monaco.editor.IStandaloneCodeEditor["onDidLayoutChange"]
  >;

  constructor(
    editor: monaco.editor.IStandaloneCodeEditor,
    onDismiss: (id: string) => void,
    onStage: (index: number, direction: HunkAction["direction"]) => void,
  ) {
    this.editor = editor;
    this.onDismiss = onDismiss;
    this.onStage = onStage;
    this.layoutSubscription = this.editor.onDidLayoutChange(() => {
      this.applyMaxWidth();
    });
  }

  private applyMaxWidth() {
    const contentWidth = this.editor.getLayoutInfo().contentWidth;
    for (const state of this.states.values()) {
      state.domNode.style.maxWidth = `${contentWidth}px`;
    }
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
  /**
   * Build one card's footer position, or null when the sequence does not
   * contain it.
 *
   * A comment missing from `ordered` is not an error worth surfacing: the
   * session-wide list is fetched separately from the per-file one, so for a
   * frame after a comment arrives the file's list can legitimately hold one
   * the sequence has not caught up with. Drawing that card without a footer
   * is better than drawing a wrong position.
   */
  private navigationFor(comment: ReviewComment): CommentNavigation | null {
    const sequence = this.sequence;
    if (!sequence) return null;

    const index = sequence.ordered.findIndex((entry) => entry.id === comment.id);
    if (index < 0) return null;

    const previous = sequence.ordered[index - 1];
    const next = sequence.ordered[index + 1];
    return {
      position: index + 1,
      total: sequence.ordered.length,
      ...(previous ? { onPrevious: () => sequence.goTo(previous) } : {}),
      ...(next ? { onNext: () => sequence.goTo(next) } : {}),
    };
  }

  set(
    comments: readonly ReviewComment[],
    lineCount: number,
    sequence: CommentSequence | null = null,
    hunks: readonly Hunk[] = [],
    staging: { staged: FileDiff | null; unstaged: FileDiff | null } | null = null,
    stagingBusy = false,
  ) {
    this.sequence = sequence;
    this.hunks = hunks;
    this.staging = staging;
    this.stagingBusy = stagingBusy;
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
        // Set at creation, not only from the `onDidLayoutChange` subscription:
        // a comment can be `set()` on a file already open, with no layout
        // event about to fire, and the very first paint must not be the wide
        // one this exists to prevent.
        domNode.style.maxWidth = `${this.editor.getLayoutInfo().contentWidth}px`;

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

        const stageAction = this.staging
          ? matchCommentHunk(resolvedComment, this.hunks, this.staging)
          : null;

        const root = createRoot(domNode);
        root.render(
          <ReviewCommentCard
            comment={resolvedComment}
            navigation={this.navigationFor(comment)}
            onDismiss={() => this.animateDismiss(comment.id)}
            onStage={() => {
              if (stageAction) this.onStage(stageAction.index, stageAction.direction);
            }}
            stageAction={stageAction}
            stageBusy={this.stagingBusy}
            onHeightChange={(measured) => {
              // Monaco's own view-zone renderer sets this zone's outer
              // `domNode` to `display: none` whenever the zone scrolls out
              // of the viewport (viewZones.js's `render()`) — the reserved
              // space stays intact in the whitespace model regardless, only
              // the DOM node is hidden. But the `ResizeObserver` above
              // watches the *card*, a descendant of that `domNode`, and an
              // ancestor going `display: none` collapses the card's own
              // `offsetHeight` to 0, firing this callback with a spurious
              // measurement. Writing that 0 into `zone.heightInPx` shrinks
              // the real reserved space, not just the hidden DOM node — the
              // comment then reads as having disappeared on scroll. A
              // rendered card (header + body) never legitimately measures 0
              // through this path; that height only ever reaches 0 via
              // `animateDismiss`, which mutates `zone.heightInPx` directly
              // and never through this callback.
              if (measured <= 0) return;
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
    this.layoutSubscription.dispose();
  }
}
