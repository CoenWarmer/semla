/**
 * The "cut the hunk here" affordance, one per place a hunk can still be cut.
 *
 * Architecturally this is `HunkBracketWidgets` again, and deliberately so —
 * read that file's docblock for the whole argument, which applies here
 * unchanged: a `glyphMarginClassName` decoration is a CSS class on a node
 * Monaco owns and cannot host a DOM subtree, so an actual clickable button in
 * the glyph margin has to be an `IGlyphMarginWidget` with a React root
 * (`createRoot`, React 19) mounted into the node `getDomNode()` hands over.
 * Monaco only ever touches that outer node's own position and size, never its
 * children, which is what makes the root safe.
 *
 * Two differences from the bracket widget, both following from what a
 * boundary is.
 *
 * **The lane is `Center`.** The glyph margin renders one occupant per (line,
 * lane), which is why the bracket widget pinned itself to `Right` and the
 * removed-marker decoration to `Left` (see its comment in code-editor.tsx's
 * `optionsFor`): a pure-removal hunk anchors both to the same line. A split
 * button anchors to a line *inside* a hunk, so it collides with both by
 * construction — every line a button sits on is a line the bracket spans, and
 * a boundary above a removed run is exactly where the removed-marker glyph
 * is. `Center` is the third lane and nothing else in this editor claims it.
 *
 * **There is no scroll subscription.** The bracket widget re-renders on
 * scroll because its node is sized to a hunk's whole span and Monaco clamps
 * the anchor of a widget taller than the viewport. A split button is one line
 * high at a single line, so Monaco's own positioning is the whole story.
 */

import { createRoot, type Root } from "react-dom/client";

import type { Hunk } from "@/lib/review/review-types";

import { monaco } from "./monaco-setup";
import type { StageDirection } from "./review-hunk-match";
import { Button } from "../ui/button";
import { ArrowsInLineVerticalIcon, ScissorsIcon } from "@phosphor-icons/react";

type OnBoundary = (
  direction: StageDirection,
  hunk: Hunk,
  boundary: number,
) => void;

export interface HunkSplitEntry {
  key: string;
  /** `split` offers a new cut; `merge` undoes one already made. */
  kind: "split" | "merge";
  /** 1-based line in the new file whose top edge the cut sits at. */
  line: number;
  /** Which staging diff `hunk` belongs to. */
  direction: StageDirection;
  /** The hunk of the staging diff the cut is recorded against. */
  hunk: Hunk;
  /** Offset into `hunk.lines` — see `SplitBoundary.boundary`. */
  boundary: number;
}

/**
 * The button itself, on the line that begins the part after the cut, styled
 * like the stage/unstage button beside it: scissors to cut there, or a merge
 * icon where a cut already is.
 *
 * A split button is invisible until hovered (`.semla-hunk-split-button`,
 * globals.css). The gutter already carries a bracket, a removal glyph and the
 * line number, and a hunk of forty lines offers thirty-nine of these — drawn
 * at rest they would be the loudest thing in the margin and about the least
 * often wanted. A merge button is shown at rest: there is one per cut, and
 * it is the only mark of where a cut is.
 */
function HunkSplitButton({
  busy,
  height,
  kind,
  onClick,
}: {
  busy: boolean;
  height: number;
  kind: HunkSplitEntry["kind"];
  onClick: () => void;
}) {
  const label = kind === "merge" ? "Merge with the part above" : "Split hunk here";
  return (
    <div style={{ height }}>
      <Button
        aria-label={label}
        className={`${kind === "merge" ? "semla-hunk-merge-button" : "semla-hunk-split-button"} semla-hunk-bracket-button`}
        disabled={busy}
        size="icon-xs"
        type="button"
        variant="outline"
        onClick={(event) => {
          event.stopPropagation();
          onClick();
        }}
        onMouseDown={(event) => {
          event.stopPropagation();
        }}
        title={label}
      >
        {kind === "merge" ? <ArrowsInLineVerticalIcon /> : <ScissorsIcon />}
      </Button>
    </div>
  );
}

interface WidgetState {
  widget: monaco.editor.IGlyphMarginWidget;
  root: Root;
}

/**
 * One glyph-margin widget per available cut.
 *
 * Rebuilt wholesale on every `set()`, for the same reason
 * `HunkBracketWidgets` is: a boundary's key is derived from a position in a
 * hunk of one diff read, and every stage or unstage renumbers and reshapes
 * those hunks, so there is no identity to diff between calls. Each entry's
 * React root is unmounted before its widget is removed.
 */
export class HunkSplitWidgets {
  private readonly editor: monaco.editor.IStandaloneCodeEditor;
  private states = new Map<string, WidgetState>();
  private readonly onSplit: OnBoundary;
  private readonly onMerge: OnBoundary;
  private busy = false;

  constructor(
    editor: monaco.editor.IStandaloneCodeEditor,
    onSplit: OnBoundary,
    onMerge: OnBoundary,
  ) {
    this.editor = editor;
    this.onSplit = onSplit;
    this.onMerge = onMerge;
  }

  private clear() {
    for (const state of this.states.values()) {
      const { root } = state;
      this.editor.removeGlyphMarginWidget(state.widget);
      // Deferred for the reason `HunkBracketWidgets.set` gives: unmounting
      // synchronously while React is rendering a parent warns. Monaco has
      // already let the node go.
      setTimeout(() => root.unmount(), 0);
    }
    this.states = new Map();
  }

  set(entries: readonly HunkSplitEntry[], busy: boolean) {
    this.busy = busy;
    this.clear();

    const lineHeight = this.editor.getOption(
      monaco.editor.EditorOption.lineHeight,
    );

    for (const entry of entries) {
      const domNode = document.createElement("div");

      const widget: monaco.editor.IGlyphMarginWidget = {
        getDomNode: () => domNode,
        getId: () => `semla-hunk-split-${entry.key}`,
        getPosition: () => ({
          lane: monaco.editor.GlyphMarginLane.Center,
          range: {
            endColumn: 1,
            endLineNumber: entry.line,
            startColumn: 1,
            startLineNumber: entry.line,
          },
          // Above the bracket, which is at 100: a bracket spanning several
          // lines would otherwise cover the split buttons inside its span.
          // A merge above a split: boundaries around a removed run can anchor
          // to the same line, and only one occupant of a lane is drawn.
          zIndex: entry.kind === "merge" ? 120 : 110,
        }),
      };

      const root = createRoot(domNode);
      root.render(
        <HunkSplitButton
          busy={this.busy}
          height={lineHeight}
          kind={entry.kind}
          onClick={() =>
            (entry.kind === "merge" ? this.onMerge : this.onSplit)(
              entry.direction,
              entry.hunk,
              entry.boundary,
            )
          }
        />,
      );

      this.editor.addGlyphMarginWidget(widget);
      this.states.set(entry.key, { root, widget });
    }
  }

  dispose() {
    this.clear();
  }
}
