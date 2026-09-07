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
  onClick,
}: {
  action: HunkAction;
  busy: boolean;
  onClick: () => void;
}) {
  const isStage = action.direction === "stage";
  const label = isStage ? "Stage hunk" : "Unstage hunk";
  const colorClass = isStage ? "text-emerald-500" : "text-destructive";

  return (
    <div className="semla-hunk-bracket">
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
  onClick,
}: {
  action: HunkAction;
  busy: boolean;
  lineCount: number;
  onClick: () => void;
}) {
  if (lineCount <= 1) {
    return (
      <div className="semla-hunk-bracket semla-hunk-bracket-single">
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

  return <HunkBracket action={action} busy={busy} onClick={onClick} />;
}

interface WidgetState {
  widget: monaco.editor.IGlyphMarginWidget;
  root: Root;
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

  constructor(
    editor: monaco.editor.IStandaloneCodeEditor,
    onStage: (index: number, direction: HunkAction["direction"]) => void,
  ) {
    this.editor = editor;
    this.onStage = onStage;
  }

  set(entries: readonly HunkBracketEntry[], busy: boolean) {
    const lineHeight = this.editor.getOption(
      monaco.editor.EditorOption.lineHeight,
    );

    for (const state of this.states.values()) {
      state.root.unmount();
      this.editor.removeGlyphMarginWidget(state.widget);
    }
    this.states = new Map();

    for (const entry of entries) {
      const domNode = document.createElement("div");
      domNode.className = "semla-hunk-bracket-host";

      const lineCount = Math.max(1, entry.endLine - entry.startLine + 1);
      domNode.style.height = `${lineCount * lineHeight}px`;
      domNode.style.width = "100%";

      const widget: monaco.editor.IGlyphMarginWidget = {
        getDomNode: () => domNode,
        getId: () => `semla-hunk-bracket-${entry.key}`,
        getPosition: () => ({
          lane: monaco.editor.GlyphMarginLane.Center,
          range: {
            endColumn: 1,
            endLineNumber: entry.startLine,
            startColumn: 1,
            startLineNumber: entry.startLine,
          },
          zIndex: 100,
        }),
      };

      const root = createRoot(domNode);
      root.render(
        <HunkBracketRoot
          action={entry.action}
          busy={busy}
          lineCount={lineCount}
          onClick={() => this.onStage(entry.action.index, entry.action.direction)}
        />,
      );

      this.editor.addGlyphMarginWidget(widget);
      this.states.set(entry.key, { root, widget });
    }
  }

  dispose() {
    for (const state of this.states.values()) {
      state.root.unmount();
      this.editor.removeGlyphMarginWidget(state.widget);
    }
    this.states.clear();
  }
}
