"use client";

/**
 * The review editor: one file, editable, with the turn's changes coloured in
 * place.
 *
 * Not a two-pane diff. A side-by-side view halves the width available to read
 * code in, and the right-hand pane of a diff is an odd place to type — so this
 * is a single full-width editor that happens to know what changed. Reading and
 * editing are then the same act rather than two modes.
 *
 * Monaco is created directly rather than through a React wrapper. The wrapper
 * loads Monaco from a CDN by default, which this application will not depend
 * on to render itself, and it encourages reading the editor instance during
 * render — which the React Compiler rules in this repository report as an
 * error. Here the instance lives in a ref that only effects and handlers ever
 * touch.
 */

import { useEffect, useRef } from "react";

import type { Hunk } from "@/lib/review-types";

import {
  configureMonaco,
  DARK_THEME,
  LIGHT_THEME,
  languageForPath,
  monaco,
} from "./monaco-setup";
import {
  buildDecorations,
  firstChangedLine,
  type Decoration,
} from "./review-decorations";

const CLASS_FOR_KIND = {
  "added-line": "semla-review-added-line",
  "added-span": "semla-review-added-span",
  "removed-marker": "semla-review-removed-marker",
} as const;

/**
 * How each kind of decoration is drawn.
 *
 * A line decoration tints the whole row and marks the gutter; a span decoration
 * is an inline range and must not be whole-line, or it would swallow the row it
 * is meant to pick characters out of. A removal has no row to tint at all — the
 * content is gone — so it is a glyph in the margin with the count on hover.
 */
function optionsFor(
  decoration: Decoration,
): monaco.editor.IModelDecorationOptions {
  if (decoration.kind === "removed-marker") {
    const plural = decoration.removedCount === 1 ? "" : "s";
    return {
      glyphMarginClassName: CLASS_FOR_KIND["removed-marker"],
      glyphMarginHoverMessage: {
        value: `${decoration.removedCount} line${plural} removed here`,
      },
    };
  }

  if (decoration.kind === "added-span") {
    return { className: CLASS_FOR_KIND["added-span"] };
  }

  return {
    className: CLASS_FOR_KIND["added-line"],
    isWholeLine: true,
    linesDecorationsClassName: "semla-review-added-gutter",
  };
}

export interface CodeEditorProps {
  /** Project-relative path. Chooses the language and keys the model. */
  path: string;
  /** The file as it is on disk. Seeds the model the first time a path is seen. */
  value: string;
  /** The whole change since HEAD, which is what gets coloured. */
  hunks: readonly Hunk[];
  readOnly?: boolean;
  theme?: "dark" | "light";
  /** Fires on every edit, so the panel can track what is unsaved. */
  onChange?: (value: string) => void;
  /** Cmd/Ctrl-S. The panel decides what saving means. */
  onSave?: () => void;
  /**
   * A line to scroll into view, with a counter so that asking for the same
   * line twice is two requests rather than an unchanged prop.
   */
  reveal?: { line: number; nonce: number } | null;
  /**
   * Right-click actions. Both are handed a one-based line and nothing else:
   * naming the function it falls inside needs the type checker, which lives on
   * the server, so the menu asks a question rather than answering one.
   */
  onExplainLine?: (line: number) => void;
  onVisualizeLine?: (line: number) => void;
}

export default function CodeEditor({
  hunks,
  onChange,
  onExplainLine,
  onSave,
  onVisualizeLine,
  path,
  readOnly = false,
  reveal = null,
  theme = "dark",
  value,
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const decorationsRef =
    useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  /**
   * Models by path, so an edit survives looking at another file and coming
   * back. A single model with setValue would be less code and would throw the
   * operator's work away the moment they clicked a second row.
   */
  const modelsRef = useRef(new Map<string, monaco.editor.ITextModel>());

  // The callbacks live in refs so a parent re-render with new closures does
  // not tear down and rebuild the editor.
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const onExplainRef = useRef(onExplainLine);
  const onVisualizeRef = useRef(onVisualizeLine);
  useEffect(() => {
    onChangeRef.current = onChange;
    onSaveRef.current = onSave;
    onExplainRef.current = onExplainLine;
    onVisualizeRef.current = onVisualizeLine;
  }, [onChange, onExplainLine, onSave, onVisualizeLine]);

  // Create once. An entry dropped without dispose leaks the editor and every
  // model it holds, and this panel is opened and closed all day.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const api = configureMonaco();

    const editor = api.editor.create(host, {
      automaticLayout: true,
      // Colour decorators ask the editor worker for document colours.
      colorDecorators: false,
      fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
      fontSize: 12.5,
      glyphMargin: true,
      // Link detection is another editor-worker consumer, and a review pane
      // is not a place anyone clicks a URL out of.
      links: false,
      minimap: { enabled: false },
      // Nothing here is a suggestion source worth interrupting a read for —
      // and word-based suggestions are computed in the editor worker, which
      // this panel deliberately runs without. See monaco-setup.ts.
      occurrencesHighlight: "off",
      quickSuggestions: false,
      renderLineHighlight: "line",
      renderWhitespace: "selection",
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      tabSize: 2,
      wordBasedSuggestions: "off",
    });

    editorRef.current = editor;
    decorationsRef.current = editor.createDecorationsCollection([]);

    const changeSubscription = editor.onDidChangeModelContent(() => {
      onChangeRef.current?.(editor.getValue());
    });

    editor.addCommand(
      api.KeyMod.CtrlCmd | api.KeyCode.KeyS,
      () => onSaveRef.current?.(),
    );

    /**
     * Right-click actions.
     *
     * Registered once, against the refs above, so a parent re-render does not
     * re-register them — `addAction` returns a disposable and adding the same
     * id twice leaves two entries in the menu.
     *
     * The line comes from `getPosition` rather than from the mouse event:
     * Monaco moves the cursor to the right-clicked token before opening the
     * menu, so the cursor *is* where the operator clicked, and reading it
     * keeps the actions working from the keyboard too.
     *
     * They sit in the "navigation" group, which is where Go to Definition
     * would be. There is no language service here, so that group is otherwise
     * empty and these land at the top of the menu.
     */
    const explain = editor.addAction({
      contextMenuGroupId: "navigation",
      contextMenuOrder: 1.1,
      id: "semla.explainFunction",
      label: "Explain function",
      run: (instance) => {
        const line = instance.getPosition()?.lineNumber;
        if (line) onExplainRef.current?.(line);
      },
    });

    const visualize = editor.addAction({
      contextMenuGroupId: "navigation",
      contextMenuOrder: 1.2,
      id: "semla.visualizeFunction",
      label: "Visualize function",
      run: (instance) => {
        const line = instance.getPosition()?.lineNumber;
        if (line) onVisualizeRef.current?.(line);
      },
    });

    return () => {
      changeSubscription.dispose();
      explain.dispose();
      visualize.dispose();
      editor.dispose();
      modelsRef.current.forEach((model) => model.dispose());
      modelsRef.current.clear();
      editorRef.current = null;
      decorationsRef.current = null;
    };
  }, []);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
  }, [readOnly]);

  useEffect(() => {
    monaco.editor.setTheme(theme === "dark" ? DARK_THEME : LIGHT_THEME);
  }, [theme]);

  // Swap the model when the file changes. `value` seeds a path the first time
  // it is seen and is not written back over an existing model: by then the
  // model may hold edits the operator has not saved, and the panel remounts
  // this component when it genuinely wants to reload from disk.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    const models = modelsRef.current;
    let model = models.get(path);

    if (!model) {
      model = monaco.editor.createModel(value, languageForPath(path));
      models.set(path, model);
    }

    editor.setModel(model);
  }, [path, value]);

  // Decorations follow the hunks. Monaco anchors these to the model, so they
  // shift with the operator's own edits rather than scattering — they go stale
  // in meaning, not in position, and the panel refreshes them on save.
  useEffect(() => {
    const editor = editorRef.current;
    const collection = decorationsRef.current;
    const model = editor?.getModel();
    if (!editor || !collection || !model) return;

    const lineCount = model.getLineCount();
    // A diff read a moment ago can describe a file the operator has since
    // shortened. An out-of-range decoration is a thrown error in Monaco.
    const clamp = (line: number) => Math.min(Math.max(1, line), lineCount);

    collection.set(
      buildDecorations(hunks).map((decoration) => ({
        options: optionsFor(decoration),
        range: new monaco.Range(
          clamp(decoration.startLine),
          decoration.startColumn ?? 1,
          clamp(decoration.endLine),
          decoration.endColumn ??
            model.getLineMaxColumn(clamp(decoration.endLine)),
        ),
      })),
    );
  }, [hunks, path]);

  // Open on the change rather than at the top of the file: a review starts at
  // what moved, and a 900-line file's first hunk is often nowhere near line 1.
  useEffect(() => {
    const editor = editorRef.current;
    const line = firstChangedLine(hunks);
    if (!editor || line === null) return;

    editor.revealLineNearTop(line, monaco.editor.ScrollType.Immediate);
  }, [hunks, path]);

  // Asked for a specific line — a hunk row was clicked.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !reveal) return;

    editor.revealLineNearTop(reveal.line, monaco.editor.ScrollType.Smooth);
    editor.setPosition({ column: 1, lineNumber: reveal.line });
  }, [reveal]);

  return <div className="h-full w-full" ref={hostRef} />;
}
