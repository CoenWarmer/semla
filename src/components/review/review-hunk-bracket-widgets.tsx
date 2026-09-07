/**
 * The stage/unstage affordance for a hunk, drawn as a real button in the
 * editor's glyph margin rather than a `glyphMarginClassName` CSS glyph.
 *
 * `IGlyphMarginWidget` (`addGlyphMarginWidget`/`removeGlyphMarginWidget`) is
 * the Monaco API for exactly this: a DOM node Monaco itself positions inside
 * the glyph-margin lane and repositions on scroll/layout, the same
 * mechanism the built-in diff editor's revert-arrow feature uses
 * (`revertButtonsFeature.js`, `RevertButton implements IGlyphMarginWidget`,
 * with its own `addEventListener("click", ...)` on the node it returns from
 * `getDomNode()`). A `glyphMarginClassName` decoration cannot host a DOM
 * subtree at all — it is a CSS class string Monaco paints onto a node it
 * owns, one per line — which is what forced the previous approach
 * (`review-hunk-glyphs.ts`, deleted) into pure CSS glyphs and a side-map
 * mouse-target lookup instead of a real element with its own click handler.
 *
 * Monaco anchors the widget's *position* to a single line — the range's
 * `startLineNumber`, clamped into the viewport (`glyphMargin.js`,
 * `_collectWidgetBasedGlyphRenderRequest`/`render`) — and paints the node's
 * top edge at that line's top. It never inspects the node's own height, so
 * the node is sized taller than one line, to the hunk's full changed-line
 * span (`(endLine - startLine + 1) * lineHeight`), and grows downward from
 * that anchor to cover every line the hunk spans. Nothing stops that node
 * from painting over the lines below its anchor; nothing in this file's CSS
 * gives it a click target anywhere but the button itself.
 *
 * A React root is mounted into that node (`createRoot`, not `render()` from
 * the old `react-dom` entry point — this repository is on React 19). The
 * widget class exists at all only because Monaco identifies and positions
 * widgets through a small stable-identity object; everything it draws is a
 * `<HunkBracket>` component tree rendered into `getDomNode()`'s node. Monaco
 * only ever touches that outer node's `style.position/top/left/width/height`
 * (`glyphMargin.js`, `render()`) — it does not touch children — so mounting
 * a React tree inside is safe on the same grounds the deleted
 * `review-hunk-widgets.ts` gave for *not* doing this with a content widget:
 * that reasoning was about Monaco's own positioning of the outer node
 * fighting a React root mounted at that same outer node, which does not
 * apply here since the outer node stays exactly what `getDomNode()` handed
 * over and only its children are React's.
 */

import { MinusIcon, PlusIcon } from "lucide-react";
import { createRoot, type Root } from "react-dom/client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Hunk } from "@/lib/review-types";

import { hunkBracketLineCount } from "./review-hunk-bracket-geometry";
import { monaco } from "./monaco-setup";
import type { HunkAction } from "./review-hunk-match";

export interface HunkBracketEntry {
  key: string;
  /** First line of the hunk's own changed-line span (1-based, new file). */
  startLine: number;
  /** Last line of that span. Equal to `startLine` for a single-line hunk. */
  endLine: number;
  hunk: Hunk;
  action: HunkAction;
}

/**
 * The bracket-and-button drawn inside one widget's dom node.
 *
 * The node's own height is `lineCount * lineHeight`; the button centers in
 * it via flexbox. For a single-line hunk there is nothing to bracket, so the
 * connector and caps are omitted rather than kept and hidden — the research
 * this was built from calls out a hidden one-line-height sliver as a
 * rounding risk otherwise.
 */
function HunkBracket({
  action,
  busy,
  height,
  onClick,
}: {
  action: HunkAction;
  busy: boolean;
  height: number;
  onClick: () => void;
}) {
  const isStage = action.direction === "stage";
  const label = isStage ? "Stage hunk" : "Unstage hunk";
  const colorClass = isStage ? "text-emerald-500" : "text-destructive";

  return (
    <div className="semla-hunk-bracket" style={{ height }}>
      <div
        className={cn(
          "semla-hunk-bracket-line",
          isStage ? "border-emerald-500/40" : "border-destructive/40",
        )}
      />
      <div
        className={cn(
          "semla-hunk-bracket-cap semla-hunk-bracket-cap-top",
          isStage ? "border-emerald-500/40" : "border-destructive/40",
        )}
      />
      <div
        className={cn(
          "semla-hunk-bracket-cap semla-hunk-bracket-cap-bottom",
          isStage ? "border-emerald-500/40" : "border-destructive/40",
        )}
      />
      <Button
        aria-label={label}
        className={cn(
          "semla-hunk-bracket-button pointer-events-auto",
          colorClass,
        )}
        disabled={busy}
        onClick={(event) => {
          event.stopPropagation();
          onClick();
        }}
        onMouseDown={(event) => {
          event.stopPropagation();
        }}
        size="icon-xs"
        title={label}
        type="button"
        variant="outline"
      >
        {isStage ? <PlusIcon /> : <MinusIcon />}
      </Button>
    </div>
  );
}

/**
 * Wrapper that keeps the connector/caps out of the DOM entirely for a
 * single-line hunk (`lineCount === 1`), rather than rendering a zero-height
 * bracket.
 */
function HunkBracketRoot({
  action,
  busy,
  lineCount,
  lineHeight,
  onClick,
}: {
  action: HunkAction;
  busy: boolean;
  lineCount: number;
  lineHeight: number;
  onClick: () => void;
}) {
  if (lineCount <= 1) {
    return (
      <div
        className="semla-hunk-bracket semla-hunk-bracket-single"
        style={{ height: lineHeight }}
      >
        <Button
          aria-label={action.direction === "stage" ? "Stage hunk" : "Unstage hunk"}
          className={cn(
            "semla-hunk-bracket-button pointer-events-auto",
            action.direction === "stage" ? "text-emerald-500" : "text-destructive",
          )}
          disabled={busy}
          onClick={(event) => {
            event.stopPropagation();
            onClick();
          }}
          onMouseDown={(event) => {
            event.stopPropagation();
          }}
          size="icon-xs"
          title={action.direction === "stage" ? "Stage hunk" : "Unstage hunk"}
          type="button"
          variant="outline"
        >
          {action.direction === "stage" ? <PlusIcon /> : <MinusIcon />}
        </Button>
      </div>
    );
  }

  return (
    <HunkBracket
      action={action}
      busy={busy}
      height={lineCount * lineHeight}
      onClick={onClick}
    />
  );
}

interface WidgetState {
  widget: monaco.editor.IGlyphMarginWidget;
  root: Root;
  entry: HunkBracketEntry;
}

/**
 * One glyph-margin widget per staged/unstaged hunk. A hunk whose range
 * matches neither diff (see `matchHunkAction`) gets no widget — there is no
 * single action that would be honest about what clicking it does.
 *
 * Rebuilt wholesale on every `set()` call, same choice `review-hunk-glyphs.ts`
 * made: a hunk's key is its position, not its identity across staging
 * changes, so there is no stable id to diff between calls. Each entry's
 * React root is unmounted before its widget is removed — a leaked root is a
 * real console-warning/memory issue, unlike a leaked plain DOM node.
 */
export class HunkBracketWidgets {
  private readonly editor: monaco.editor.IStandaloneCodeEditor;
  private states = new Map<string, WidgetState>();
  private onStage: (index: number, direction: HunkAction["direction"]) => void;
  private busy = false;
  /**
   * `onDidScrollChange`/`onDidLayoutChange` fire far more often than a
   * hunk taller than the viewport actually needs a re-render — e.g. every
   * pixel of a smooth-scroll animation. `getVisibleRanges()`
   * (`editor.api.d.ts`, `getVisibleRanges(): Range[]`) is cheap to read but
   * `root.render` is not free to call once per hunk on every such tick, so
   * this is compared against the previous value and skipped when the
   * effective top line has not actually changed.
   */
  private lastVisibleTopLine = 1;
  private readonly scrollSubscription: ReturnType<
    monaco.editor.IStandaloneCodeEditor["onDidScrollChange"]
  >;
  private readonly layoutSubscription: ReturnType<
    monaco.editor.IStandaloneCodeEditor["onDidLayoutChange"]
  >;

  constructor(
    editor: monaco.editor.IStandaloneCodeEditor,
    onStage: (index: number, direction: HunkAction["direction"]) => void,
  ) {
    this.editor = editor;
    this.onStage = onStage;

    // A hunk taller than the editor's viewport has its widget's anchor
    // clamped by Monaco to the viewport's own top line once the hunk's own
    // `startLine` scrolls above it (`glyphMargin.js`,
    // `_collectWidgetBasedGlyphRenderRequest`: `Math.max(startLineNumber,
    // visibleStartLineNumber)`). The bracket's rendered height has to track
    // that clamp — recomputed here on every scroll and layout change, since
    // either can change which line is at the top of the viewport — rather
    // than only at construction/`set()` time.
    this.scrollSubscription = this.editor.onDidScrollChange(() => {
      this.updateForScroll();
    });
    this.layoutSubscription = this.editor.onDidLayoutChange(() => {
      this.updateForScroll();
    });
  }

  /**
   * The line Monaco's own culling/clamping (`glyphMargin.js`,
   * `_collectWidgetBasedGlyphRenderRequest`'s `visibleStartLineNumber`,
   * fed by `ctx.visibleRange`) actually uses, reproduced directly from
   * `getScrollTop()`/line height rather than `getVisibleRanges()`.
   * `getVisibleRanges()` (`viewModelImpl.js`'s `getCompletelyVisibleViewRange`)
   * is a *stricter* range — it drops a top line that is only partially
   * scrolled into view, which `ctx.visibleRange`
   * (`viewLinesViewportData.js`'s `ViewportData`, built from the same
   * *partial* `startLineNumber`/`endLineNumber` `getLinesViewportData`
   * computes) does not. Whenever the scroll offset is not an exact
   * multiple of the line height — true for most of a scroll gesture —
   * `getVisibleRanges()` reports one line later than the line Monaco's
   * widget is actually clamped/anchored to, which would size the bracket
   * one line height short. `getLineNumberAtOrAfterVerticalOffset`'s own
   * binary search reduces, for a uniform line height, to this division.
   */
  private visibleTopLine(): number {
    const lineHeight = this.editor.getOption(
      monaco.editor.EditorOption.lineHeight,
    );
    if (lineHeight <= 0) return 1;
    return Math.floor(this.editor.getScrollTop() / lineHeight) + 1;
  }

  private updateForScroll() {
    const visibleTopLine = this.visibleTopLine();
    if (visibleTopLine === this.lastVisibleTopLine) return;
    this.lastVisibleTopLine = visibleTopLine;

    const lineHeight = this.editor.getOption(
      monaco.editor.EditorOption.lineHeight,
    );
    for (const state of this.states.values()) {
      this.renderState(state, lineHeight, visibleTopLine);
    }
  }

  private renderState(
    state: WidgetState,
    lineHeight: number,
    visibleTopLine: number,
  ) {
    const { entry } = state;
    const lineCount = hunkBracketLineCount(entry, visibleTopLine);

    state.root.render(
      <HunkBracketRoot
        action={entry.action}
        busy={this.busy}
        lineCount={lineCount}
        lineHeight={lineHeight}
        onClick={() => this.onStage(entry.action.index, entry.action.direction)}
      />,
    );
  }

  set(entries: readonly HunkBracketEntry[], busy: boolean) {
    this.busy = busy;
    const lineHeight = this.editor.getOption(
      monaco.editor.EditorOption.lineHeight,
    );
    const visibleTopLine = this.visibleTopLine();
    this.lastVisibleTopLine = visibleTopLine;

    for (const state of this.states.values()) {
      state.root.unmount();
      this.editor.removeGlyphMarginWidget(state.widget);
    }
    this.states = new Map();

    for (const entry of entries) {
      const domNode = document.createElement("div");
      domNode.className = "semla-hunk-bracket-host";

      // Monaco owns this node's own height: every render pass
      // (`glyphMargin.js`'s `render()`) sets it back to exactly one line's
      // height, the same as any other glyph-margin widget, regardless of
      // what is set here. So the bracket can't be sized by sizing this
      // node — its child is the one that overflows downward from this
      // node's top edge, via its own explicit inline height and
      // `position: absolute` (`.semla-hunk-bracket` in globals.css), which
      // Monaco never touches.

      const widget: monaco.editor.IGlyphMarginWidget = {
        getDomNode: () => domNode,
        getId: () => `semla-hunk-bracket-${entry.key}`,
        getPosition: () => ({
          // A distinct lane from the removed-marker decoration's `Left`
          // (see code-editor.tsx's `optionsFor`): both can anchor to the
          // same line — a pure-removal hunk's widget and its "N lines
          // removed" glyph collapse to the same anchor line by
          // construction — and Monaco's glyph margin only ever renders one
          // occupant per (line, lane). Sharing a lane would have the
          // widget silently win and the removed-marker glyph vanish.
          lane: monaco.editor.GlyphMarginLane.Right,
          // The FULL hunk span, not just the anchor line. Monaco culls a
          // widget once its range's `endLineNumber` is above the
          // viewport's top (`glyphMargin.js`,
          // `_collectWidgetBasedGlyphRenderRequest`: `endLineNumber <
          // visibleStartLineNumber`) — with a single-point range at
          // `startLine`, that happened the instant `startLine` itself
          // scrolled out of view, even though the rest of a hunk taller
          // than the viewport was still on screen below. Spanning the
          // range to `endLine` keeps the widget alive for as long as any
          // part of the hunk is visible; `renderState`/`updateForScroll`
          // above is what keeps the bracket's own height honest once
          // Monaco clamps the anchor it renders at down to the
          // viewport's top line.
          range: {
            endColumn: 1,
            endLineNumber: entry.endLine,
            startColumn: 1,
            startLineNumber: entry.startLine,
          },
          zIndex: 100,
        }),
      };

      const root = createRoot(domNode);
      const state: WidgetState = { entry, root, widget };
      this.renderState(state, lineHeight, visibleTopLine);

      this.editor.addGlyphMarginWidget(widget);
      this.states.set(entry.key, state);
    }
  }

  dispose() {
    this.scrollSubscription.dispose();
    this.layoutSubscription.dispose();
    for (const state of this.states.values()) {
      state.root.unmount();
      this.editor.removeGlyphMarginWidget(state.widget);
    }
    this.states.clear();
  }
}
