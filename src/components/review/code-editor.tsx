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

import type { FileDiff, Hunk } from "@/lib/review-types";

import {
  configureMonaco,
  DARK_THEME,
  LIGHT_THEME,
  languageForPath,
  monaco,
} from "./monaco-setup";
import {
  registerDefinitionProvider,
  uriForWorkspacePath,
  type DefinitionProviderConfig,
} from "./definition-provider";
import {
  buildDecorations,
  firstChangedLine,
  hunkChangedLineRange,
  type Decoration,
} from "./review-decorations";
import { matchHunkAction } from "./review-hunk-match";
import { HunkBracketWidgets } from "./review-hunk-bracket-widgets";

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
      // Pinned to `Left` so it never shares a lane with the stage/unstage
      // bracket widget (review-hunk-bracket-widgets.tsx, lane `Right`) —
      // a pure-removal hunk anchors both to the same line, and Monaco's
      // glyph margin renders only one occupant per (line, lane).
      glyphMargin: { position: monaco.editor.GlyphMarginLane.Left },
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
  /**
   * Workspace-relative path of the project the file belongs to.
   *
   * Needed because a model is keyed by a workspace-relative Uri rather than by
   * the project-relative path alone: two repositories in one session both have
   * a `src/index.ts`, and one Uri for both would show the operator the wrong
   * file's buffer. It is also the address Go to Definition answers in.
   */
  project: string;
  /** The file as it is on disk. Seeds the model the first time a path is seen. */
  value: string;
  /** The whole change since HEAD, which is what gets coloured. */
  hunks: readonly Hunk[];
  /**
   * What is and is not staged, so a widget above a hunk can offer the right
   * action. Absent (or both null) when there is nothing to stage — an
   * unchanged file opened from the tree, or one with no hunk-level staging
   * at all — in which case no widgets are drawn.
   */
  staging?: { staged: FileDiff | null; unstaged: FileDiff | null } | null;
  /** A stage/unstage request is in flight; every widget's button disables. */
  stagingBusy?: boolean;
  /** A widget's button was clicked. */
  onStageHunk?: (hunks: number[], direction: "stage" | "unstage") => void;
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
  /**
   * Everything Go to Definition needs, or omitted to leave the gesture off.
   *
   * Passed as one object because the pieces are only meaningful together, and
   * because it is registered once for the editor's lifetime against refs — an
   * individual callback changing identity must not re-register the provider,
   * which would leave two answering the same position.
   */
  definition?: DefinitionProviderConfig | null;
}

export default function CodeEditor({
  definition = null,
  hunks,
  onChange,
  onExplainLine,
  onSave,
  onStageHunk,
  onVisualizeLine,
  path,
  project,
  readOnly = false,
  reveal = null,
  staging = null,
  stagingBusy = false,
  theme = "dark",
  value,
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const decorationsRef =
    useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const hunkGlyphsRef = useRef<HunkBracketWidgets | null>(null);
  const stagingBusyRef = useRef(stagingBusy);
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
  const onStageHunkRef = useRef(onStageHunk);
  const definitionRef = useRef(definition);
  useEffect(() => {
    onChangeRef.current = onChange;
    onSaveRef.current = onSave;
    onExplainRef.current = onExplainLine;
    onVisualizeRef.current = onVisualizeLine;
    onStageHunkRef.current = onStageHunk;
    definitionRef.current = definition;
  }, [
    definition,
    onChange,
    onExplainLine,
    onSave,
    onStageHunk,
    onVisualizeLine,
  ]);

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
    hunkGlyphsRef.current = new HunkBracketWidgets(editor, (index, direction) => {
      if (stagingBusyRef.current) return;
      onStageHunkRef.current?.([index], direction);
    });

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

    /**
     * Go to Definition, if the panel supplied the machinery for it.
     *
     * Registered once and delegating through the ref, so the provider Monaco
     * holds is stable for the editor's life while the selection it closes over
     * stays current. Registering per prop change would leave several providers
     * answering the same position, and Monaco merges their answers.
     *
     * `null` is a real configuration: without it the gesture stays off, which
     * is what a surface with no session context should do.
     */
    const definitionRegistration = definitionRef.current
      ? registerDefinitionProvider({
          current: () => definitionRef.current?.current() ?? null,
          languages: definitionRef.current.languages,
          onCrossFile: (workspacePath, line) =>
            definitionRef.current?.onCrossFile(workspacePath, line),
          onNotice: (message) => definitionRef.current?.onNotice(message),
          readFile: async (workspacePath) =>
            (await definitionRef.current?.readFile(workspacePath)) ?? null,
          resolve: async (request) =>
            (await definitionRef.current?.resolve(request)) ?? null,
          toWorkspacePath: (projectPath, filePath) =>
            definitionRef.current?.toWorkspacePath(projectPath, filePath) ??
            `${projectPath}/${filePath}`,
        })
      : null;

    return () => {
      changeSubscription.dispose();
      explain.dispose();
      visualize.dispose();
      definitionRegistration?.dispose();
      hunkGlyphsRef.current?.dispose();
      editor.dispose();
      modelsRef.current.forEach((model) => model.dispose());
      modelsRef.current.clear();
      editorRef.current = null;
      decorationsRef.current = null;
      hunkGlyphsRef.current = null;
    };
  }, []);

  useEffect(() => {
    stagingBusyRef.current = stagingBusy;
  }, [stagingBusy]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
  }, [readOnly]);

  useEffect(() => {
    monaco.editor.setTheme(theme === "dark" ? DARK_THEME : LIGHT_THEME);
  }, [theme]);

  /*
   * Swap the model when the file changes. `value` seeds a path the first time
   * it is seen and is not written back over an existing model: by then the
   * model may hold edits the operator has not saved, and the panel remounts
   * this component when it genuinely wants to reload from disk.
   *
   * **Models carry a Uri, and that is load-bearing rather than cosmetic.**
   * Monaco resolves a definition's `Location` through its own model registry,
   * so the file the operator is reading has to be registered under the same
   * Uri the definition provider builds — otherwise a cmd+click within one file
   * resolves to a Uri Monaco has never heard of. Keyed workspace-relative,
   * because a project-relative key collides across repositories.
   *
   * A Uri already in the registry is adopted rather than recreated:
   * `ensureModel` may have built it to answer a definition before the operator
   * opened it, and `createModel` throws on a duplicate Uri.
   */
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    const models = modelsRef.current;
    const workspacePath = `${project}/${path}`;
    let model = models.get(workspacePath);

    if (!model) {
      const uri = uriForWorkspacePath(workspacePath);
      model =
        monaco.editor.getModel(uri) ??
        monaco.editor.createModel(value, languageForPath(path), uri);
      models.set(workspacePath, model);
    }

    editor.setModel(model);
  }, [path, project, value]);

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

  // A button in the gutter of every hunk this diff can stage or unstage on
  // its own — see review-hunk-bracket-widgets.ts for why this is a real
  // glyph-margin widget rather than a CSS glyph decoration, and
  // review-hunk-match.ts for why the action a hunk offers is not simply its
  // own index.
  useEffect(() => {
    const editor = editorRef.current;
    const glyphs = hunkGlyphsRef.current;
    if (!editor || !glyphs) return;

    if (!staging || (!staging.staged && !staging.unstaged)) {
      glyphs.set([], stagingBusy);
      return;
    }

    const model = editor.getModel();
    const lineCount = model?.getLineCount() ?? 1;
    // A diff read a moment ago can describe a file the operator has since
    // shortened, same as the decorations effect above.
    const clamp = (line: number) => Math.min(Math.max(1, line), lineCount);

    const entries = hunks.flatMap((hunk) => {
      const action = matchHunkAction(hunk, staging);
      if (!action) return [];

      const range = hunkChangedLineRange(hunk);

      return [
        {
          action,
          endLine: clamp(range.end),
          hunk,
          key: `${hunk.oldStart}-${hunk.newStart}`,
          startLine: clamp(range.start),
        },
      ];
    });

    glyphs.set(entries, stagingBusy);
  }, [hunks, staging, stagingBusy]);

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
