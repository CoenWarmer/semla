/**
 * A small persistent action bar above each hunk, for staging it from the
 * editor rather than only from the changed-files sidebar.
 *
 * Built from Monaco content widgets rather than a hover: a hover is gone the
 * moment the pointer leaves the line, and the whole point here is a button
 * the operator can actually aim at and click. `ContentWidgetPositionPreference.ABOVE`
 * pins it to the hunk's own anchor line, and Monaco keeps it there as the
 * document scrolls and edits move lines around underneath it.
 *
 * Plain DOM, not React. `IContentWidget.getDomNode()` hands Monaco a node it
 * owns and repositions directly — mounting a React tree into it would fight
 * Monaco for that node on every layout pass. The one piece of state a button
 * needs (label, disabled) is small enough that direct DOM writes are simpler
 * than bridging a portal in and out for it.
 */

import { monaco } from "./monaco-setup";
import type { Hunk } from "@/lib/review-types";
import type { HunkAction } from "./review-hunk-match";
import { hunkLocation, hunkSummary } from "./review-hunk-list";

const WIDGET_ID_PREFIX = "semla.hunk-action.";

class HunkActionWidget implements monaco.editor.IContentWidget {
  readonly allowEditorOverflow = false;
  suppressMouseDown = true;

  private readonly domNode: HTMLDivElement;
  private readonly button: HTMLButtonElement;
  private readonly id: string;
  private readonly line: number;

  constructor(
    key: string,
    line: number,
    hunk: Hunk,
    action: HunkAction,
    busy: boolean,
    onClick: () => void,
  ) {
    this.id = `${WIDGET_ID_PREFIX}${key}`;
    this.line = line;

    const { added, removed } = hunkSummary(hunk);

    this.domNode = document.createElement("div");
    this.domNode.className = "semla-hunk-action-widget";

    const location = document.createElement("span");
    location.className = "semla-hunk-action-widget-location";
    location.textContent = hunkLocation(hunk);
    this.domNode.appendChild(location);

    if (added > 0) {
      const addedSpan = document.createElement("span");
      addedSpan.className = "semla-hunk-action-widget-added";
      addedSpan.textContent = `+${added}`;
      this.domNode.appendChild(addedSpan);
    }
    if (removed > 0) {
      const removedSpan = document.createElement("span");
      removedSpan.className = "semla-hunk-action-widget-removed";
      removedSpan.textContent = `\u2212${removed}`;
      this.domNode.appendChild(removedSpan);
    }

    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.className = "semla-hunk-action-widget-button";
    this.button.textContent =
      action.direction === "stage" ? "Stage hunk" : "Unstage hunk";
    this.button.disabled = busy;
    this.button.addEventListener("click", (event) => {
      event.stopPropagation();
      onClick();
    });
    this.domNode.appendChild(this.button);
  }

  getId() {
    return this.id;
  }

  getDomNode() {
    return this.domNode;
  }

  getPosition(): monaco.editor.IContentWidgetPosition {
    return {
      position: { column: 1, lineNumber: this.line },
      preference: [
        monaco.editor.ContentWidgetPositionPreference.ABOVE,
        monaco.editor.ContentWidgetPositionPreference.BELOW,
      ],
    };
  }
}

/**
 * One widget per staged/unstaged hunk. A hunk whose range matches neither
 * diff (see `matchHunkAction`) gets no widget — there is no single action
 * that would be honest about what clicking it does.
 */
export class HunkActionWidgets {
  private readonly editor: monaco.editor.IStandaloneCodeEditor;
  private readonly widgets = new Map<string, HunkActionWidget>();

  constructor(editor: monaco.editor.IStandaloneCodeEditor) {
    this.editor = editor;
  }

  /**
   * Replace every widget with the given set.
   *
   * Rebuilt wholesale on every call rather than diffed: a review pane's hunk
   * list changes size rarely (a stage/unstage, a save, a file switch), so the
   * dispose-and-recreate cost is not one this needs to optimise away, and it
   * is the only way that is not its own source of staleness.
   */
  set(
    entries: readonly {
      key: string;
      line: number;
      hunk: Hunk;
      action: HunkAction;
    }[],
    busy: boolean,
    onStage: (index: number, direction: HunkAction["direction"]) => void,
  ) {
    // A hunk's key is its position, not its identity across staging changes:
    // staging one hunk shifts every later hunk's `full` index in the diff
    // that produced `key`, and can flip the direction a later hunk's own
    // action means. Reusing an existing widget would mean either re-binding
    // its click handler on every call or risking a closure that still fires
    // the action it was created with. Recreating is the simpler correct
    // option, and cheap enough — see the class doc comment.
    for (const widget of this.widgets.values()) {
      this.editor.removeContentWidget(widget);
    }
    this.widgets.clear();

    for (const entry of entries) {
      const widget = new HunkActionWidget(
        entry.key,
        entry.line,
        entry.hunk,
        entry.action,
        busy,
        () => onStage(entry.action.index, entry.action.direction),
      );
      this.widgets.set(entry.key, widget);
      this.editor.addContentWidget(widget);
    }
  }

  dispose() {
    for (const widget of this.widgets.values()) {
      this.editor.removeContentWidget(widget);
    }
    this.widgets.clear();
  }
}
