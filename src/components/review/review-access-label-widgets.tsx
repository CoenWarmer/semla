/**
 * The "who read this" chip drawn above each band the agent read or wrote.
 *
 * A content widget (`addContentWidget`/`removeContentWidget`) with
 * `ContentWidgetPositionPreference.ABOVE`, not a view zone. A view zone
 * inserts a real row and pushes the code down, which would reflow the file
 * every time the scrubber moves — and the scrubber moves several times a
 * second while following a turn, so the operator would be reading code that
 * will not hold still. A content widget floats over the line above the band
 * and changes no layout at all; the cost is that it can cover a line of code,
 * which is why the chip is small, offset to the right of the text's left edge
 * only as far as the band itself, and semi-transparent (see
 * `.semla-access-label` in globals.css).
 *
 * Monaco positions the outer node and nothing else — it sets
 * `style.position/top/left` on the node `getDomNode()` returns
 * (`contentWidgets.js`, `_renderWidget`) — so a React root inside it is safe
 * on exactly the grounds `review-hunk-bracket-widgets.tsx` sets out for the
 * glyph-margin case: the outer node stays Monaco's, and only its children are
 * React's.
 *
 * Rebuilt wholesale on every `set()`, same reasoning as the hunk brackets: a
 * label's identity is its anchor line, which is not stable across a change of
 * access, so there is nothing to diff.
 */

import { createRoot, type Root } from "react-dom/client";

import { cn } from "@/lib/utils";

import { monaco } from "./monaco-setup";
import type { AccessLabel } from "./review-access-labels";

/**
 * The chip itself.
 *
 * Not a `Button` — it is not actionable. `pointer-events: none` on the host
 * (globals.css) keeps it from stealing clicks or the text cursor from the line
 * it floats over, which matters because this editor is editable.
 */
function AccessLabelChip({ label }: { label: AccessLabel }) {
  return (
    <span
      className={cn(
        "semla-access-label",
        label.kind === "write"
          ? "semla-access-label-write"
          : "semla-access-label-read",
      )}
      // A title rather than a tooltip component: the host node is
      // pointer-events: none, so nothing here can receive hover events that a
      // React tooltip would need, and the native attribute is rendered by the
      // browser outside that constraint.
      title={
        label.inferred
          ? `${label.text} — path and lines inferred from a shell command`
          : label.text
      }
    >
      {label.text}
      {label.inferred ? <span aria-hidden="true">?</span> : null}
    </span>
  );
}

interface LabelState {
  widget: monaco.editor.IContentWidget;
  root: Root;
}

export class AccessLabelWidgets {
  private readonly editor: monaco.editor.IStandaloneCodeEditor;
  private states = new Map<string, LabelState>();

  constructor(editor: monaco.editor.IStandaloneCodeEditor) {
    this.editor = editor;
  }

  set(labels: readonly AccessLabel[]) {
    this.clear();

    for (const label of labels) {
      const domNode = document.createElement("div");
      domNode.className = "semla-access-label-host";

      const widget: monaco.editor.IContentWidget = {
        // The chip for a band starting at line 1 has no line above it to
        // float over, so it would be clipped by the editor's own viewport
        // without this. Overflow is permitted for every label rather than
        // only that one, so they all render identically.
        allowEditorOverflow: true,
        getDomNode: () => domNode,
        getId: () => `semla-access-label-${label.key}`,
        getPosition: () => ({
          position: { column: 1, lineNumber: label.line },
          preference: [
            monaco.editor.ContentWidgetPositionPreference.ABOVE,
            // Line 1 has nothing above it inside the content area; Monaco
            // falls through to the next preference rather than dropping the
            // widget, so BELOW keeps the chip on screen there.
            monaco.editor.ContentWidgetPositionPreference.BELOW,
          ],
        }),
        // The editor is editable and this floats over code. Without this a
        // mousedown on the chip moves the cursor to whatever is underneath.
        suppressMouseDown: true,
      };

      const root = createRoot(domNode);
      root.render(<AccessLabelChip label={label} />);

      this.editor.addContentWidget(widget);
      this.states.set(label.key, { root, widget });
    }
  }

  private clear() {
    for (const state of this.states.values()) {
      const { root } = state;
      this.editor.removeContentWidget(state.widget);
      // Deferred for the reason `review-hunk-bracket-widgets.tsx` gives:
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
