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

import type { FileDiff, Hunk } from "@/lib/review/review-types";

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
  registerLspProviders,
  type LspProviderConfig,
  type LspProviderHandle,
} from "./lsp-provider";
import {
  registerCompletionProvider,
  type CompletionProviderConfig,
} from "./completion-provider";
import {
  buildDecorations,
  firstChangedLine,
  hunkChangedLineRange,
  type Decoration,
} from "./review-decorations";
import { shouldAutoScroll, type AutoScrollState } from "./review-auto-scroll";
import { matchHunkAction } from "./review-hunk-match";
import { HunkBracketWidgets } from "./review-hunk-bracket-widgets";
import { AccessLabelWidgets } from "./review-access-label-widgets";
import { buildAccessLabels } from "./review-access-labels";
import {
  ReviewCommentWidgets,
  type CommentSequence,
} from "./review-comment-widgets";
import type { ReviewComment } from "@/lib/review/review-comment-types";
import { linesOutside } from "@/lib/pi/file-access/access-sequence";

import type { AccessHighlight } from "./review-panel-request";

/**
 * Stable identity for "no comments", matching `NO_PROJECTS` in
 * review-panel.tsx: a fresh `[]` default parameter is a new array every
 * render, which would retrigger the comments effect below on every render
 * of a parent that has not actually changed anything.
 */
const EMPTY_COMMENTS: readonly ReviewComment[] = [];

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
   * The hunk the keyboard cursor is on, when it is in this file — highlighted
   * more strongly than the rest of `hunks` so it is obvious which one a
   * `w`/`s`/space press is about to act on. Null when the cursor is
   * elsewhere, or this file's diffs have not resolved it yet.
   */
  currentHunk?: Hunk | null;
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
  /**
   * Everything hover, references, rename and diagnostics need, or omitted to
   * leave the real language server off — the same shape and the same reason
   * as `definition`: registered once, for the editor's lifetime, against
   * refs rather than the prop itself.
   */
  lsp?: LspProviderConfig | null;
  /**
   * Autocomplete, or omitted to leave the suggestion widget with nothing to
   * show. Same shape and same lifetime as `definition` and `lsp` above.
   *
   * Monaco's own suggest widget renders this — see `completion-provider.ts`
   * for why that turned out to be available after all, and `monaco-setup.ts`
   * for the contribution imports it needs.
   */
  completion?: CompletionProviderConfig | null;
  /**
   * The lines the agent read or wrote here, to mark in the gutter.
   *
   * Distinct from `hunks`, which say what *changed*: the point of the scrubber
   * is that most of what an agent looks at it does not change, and there is no
   * diff to show for it.
   */
  access?: AccessHighlight | null;
  /**
   * The agent's explanations of ranges in this file, drawn above the range
   * each is about. Distinct from `access` and `hunks` again: neither says
   * *why* the agent did something, only *what* it touched or changed.
   */
  comments?: readonly ReviewComment[];
  /**
   * The session's whole comment sequence, plus how to open one — what the
   * cards' next/previous footer steps through. Null leaves the footer off.
   *
   * Separate from `comments` because it is not about this file: the next
   * comment is frequently in another one, which only the panel can open.
   */
  commentNavigation?: CommentSequence | null;
  /** A comment's dismiss control was clicked. */
  onDismissComment?: (commentId: string) => void;
}

export default function CodeEditor({
  access = null,
  commentNavigation = null,
  comments = EMPTY_COMMENTS,
  completion = null,
  currentHunk = null,
  definition = null,
  hunks,
  lsp = null,
  onChange,
  onDismissComment,
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
  /**
   * The keyboard cursor's hunk, in a collection of its own.
   *
   * Separate from `decorationsRef` for the same reason `accessRef` is: a
   * `set()` replaces everything in the collection it is called on, and the
   * cursor moves on every keypress — sharing a collection with the diff
   * colours would mean recomputing and resetting those on every `w`/`s` too,
   * rather than only when the hunks themselves change.
   */
  const currentHunkRef =
    useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  /**
   * The agent's read/write marks, in a collection of their own.
   *
   * Separate from the diff decorations because the two answer different
   * questions and change at different times — a `set()` on one collection
   * replaces everything in it, so sharing would mean the scrubber wiping the
   * turn's diff colours every time an arrow was pressed.
   */
  const accessRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(
    null,
  );
  const hunkGlyphsRef = useRef<HunkBracketWidgets | null>(null);
  /**
   * The "read by <tool>" chips floating above each accessed band.
   *
   * A third widget owner rather than part of the access decorations, because a
   * decoration is a class name on a line Monaco owns and cannot host a DOM
   * subtree — the same constraint `review-hunk-bracket-widgets.tsx` documents.
   */
  const accessLabelsRef = useRef<AccessLabelWidgets | null>(null);
  /**
   * The agent's own explanations, drawn above the ranges they are about.
   *
   * A fourth widget owner, following `accessLabelsRef`'s own reasoning: this
   * is a DOM subtree Monaco positions but does not own the contents of, and
   * it changes on its own schedule (a new comment can arrive mid-turn, or
   * be dismissed) rather than in step with the diff or the access marks.
   */
  const commentWidgetsRef = useRef<ReviewCommentWidgets | null>(null);
  const onDismissCommentRef = useRef(onDismissComment);
  useEffect(() => {
    onDismissCommentRef.current = onDismissComment;
  }, [onDismissComment]);
  const stagingBusyRef = useRef(stagingBusy);
  /**
   * Which path the open-on-first-hunk effect has already scrolled for.
   *
   * A ref rather than state: nothing renders from it, and writing it from
   * the effect that reads it would be `react/set-state-in-effect`, which is
   * an error in this repository.
   */
  const autoScrollRef = useRef<AutoScrollState>({ scrolledPath: null });
  /**
   * Models by path, so an edit survives looking at another file and coming
   * back. A single model with setValue would be less code and would throw the
   * operator's work away the moment they clicked a second row.
   */
  const modelsRef = useRef(new Map<string, monaco.editor.ITextModel>());
  /**
   * Every `{ path, project }` the LSP bridge has been told is open, keyed the
   * same way `modelsRef` is, so the unmount cleanup can send `didClose` for
   * each rather than just whichever file happens to be on screen last.
   */
  const lspOpenedRef = useRef(
    new Map<string, { path: string; project: string }>(),
  );
  /** Coalesces keystrokes into one `didChange` rather than one per character. */
  const lspSyncTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Set once, by the registration effect below, so other effects can reach it. */
  const lspHandleRef = useRef<LspProviderHandle | null>(null);

  // The callbacks live in refs so a parent re-render with new closures does
  // not tear down and rebuild the editor.
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const onExplainRef = useRef(onExplainLine);
  const onVisualizeRef = useRef(onVisualizeLine);
  const onStageHunkRef = useRef(onStageHunk);
  const definitionRef = useRef(definition);
  const lspRef = useRef(lsp);
  const completionRef = useRef(completion);
  useEffect(() => {
    onChangeRef.current = onChange;
    onSaveRef.current = onSave;
    onExplainRef.current = onExplainLine;
    onVisualizeRef.current = onVisualizeLine;
    onStageHunkRef.current = onStageHunk;
    definitionRef.current = definition;
    lspRef.current = lsp;
    completionRef.current = completion;
  }, [
    completion,
    definition,
    lsp,
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

    // Captured now rather than read fresh in the cleanup below: neither ref
    // ever gets a new Map after mount, but the linter can't tell that from
    // a bare `.current` access, and a local variable is what it wants.
    const models = modelsRef.current;
    const lspOpened = lspOpenedRef.current;

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
      occurrencesHighlight: "off",
      /*
       * On, for identifiers only. This is what makes the widget appear as a
       * component name is typed rather than only on an explicit ctrl+space;
       * `completion-provider.ts` answers it from the language server.
       *
       * `other: false` keeps it out of comments and strings, where TS 7 has
       * nothing useful to say and the list would only be in the way.
       */
      quickSuggestions: { comments: false, other: true, strings: false },
      renderLineHighlight: "line",
      renderWhitespace: "selection",
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      /*
       * Left off explicitly, and not merely unset.
       *
       * `localityBonus` is the one `suggest` option that reaches for the
       * editor worker service in a way that starts a real worker
       * (`WordDistance.create`), which `monaco-setup.ts`'s `getWorker` guard
       * would then throw on. It defaults to false; saying so here is what
       * keeps a future "improve the ordering" change from turning it on
       * without meeting that guard first.
       */
      suggest: { localityBonus: false },
      tabSize: 2,
      /*
       * Still off. Word-based suggestions are computed in the editor worker
       * this panel runs without, and with a real language server answering
       * completions they would only add every string in the file as a
       * suggestion alongside the typed ones.
       */
      wordBasedSuggestions: "off",
    });

    editorRef.current = editor;
    decorationsRef.current = editor.createDecorationsCollection([]);
    currentHunkRef.current = editor.createDecorationsCollection([]);
    accessRef.current = editor.createDecorationsCollection([]);
    accessLabelsRef.current = new AccessLabelWidgets(editor);
    commentWidgetsRef.current = new ReviewCommentWidgets(editor, (id) => {
      onDismissCommentRef.current?.(id);
    });
    hunkGlyphsRef.current = new HunkBracketWidgets(
      editor,
      (index, direction) => {
        if (stagingBusyRef.current) return;
        onStageHunkRef.current?.([index], direction);
      },
    );

    const changeSubscription = editor.onDidChangeModelContent(() => {
      const text = editor.getValue();
      onChangeRef.current?.(text);

      // Debounced: a `didChange` per keystroke would be one request per
      // character typed, and the server's own answers only need to be as
      // fresh as the next hover or diagnostics pass, not the current one.
      //
      // Gated on language: the bridge behind this is one TypeScript server,
      // and `languageIdForPath` (lsp-host.ts) falls back to "typescript" for
      // anything it does not recognise rather than refusing it. Sending it a
      // file the server was never meant to see — `package-lock.json` did
      // this once, at nearly a megabyte — is not a request it answers
      // quickly.
      const current = lspRef.current?.current();
      if (!current) return;
      if (!lspRef.current?.languages.includes(languageForPath(current.path)))
        return;
      if (lspSyncTimeoutRef.current) clearTimeout(lspSyncTimeoutRef.current);
      lspSyncTimeoutRef.current = setTimeout(() => {
        lspRef.current?.notifySync(current.path, current.project, text);
      }, 300);
    });

    editor.addCommand(api.KeyMod.CtrlCmd | api.KeyCode.KeyS, () =>
      onSaveRef.current?.(),
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

    /**
     * Hover, references, rename and diagnostics, on the same exception as Go
     * to Definition just above: `null` leaves the bridge off, and every
     * callback delegates through the ref so the registration itself never
     * has to change.
     */
    const lspRegistration = lspRef.current
      ? registerLspProviders({
          current: () => lspRef.current?.current() ?? null,
          languages: lspRef.current.languages,
          notifyClose: (path, docProject) =>
            lspRef.current?.notifyClose(path, docProject),
          notifySync: (path, docProject, text) =>
            lspRef.current?.notifySync(path, docProject, text),
          onNotice: (message) => lspRef.current?.onNotice(message),
          prepareRename: async (request) =>
            (await lspRef.current?.prepareRename(request)) ?? null,
          readFile: async (workspacePath) =>
            (await lspRef.current?.readFile(workspacePath)) ?? null,
          requestHover: async (request) =>
            (await lspRef.current?.requestHover(request)) ?? null,
          requestReferences: async (request) =>
            (await lspRef.current?.requestReferences(request)) ?? null,
          requestRename: async (request) =>
            (await lspRef.current?.requestRename(request)) ?? null,
          subscribeDiagnostics: (onDiagnostics) => {
            const unsubscribe =
              lspRef.current?.subscribeDiagnostics(onDiagnostics);
            return () => unsubscribe?.();
          },
          toWorkspacePath: (projectPath, filePath) =>
            lspRef.current?.toWorkspacePath(projectPath, filePath) ??
            `${projectPath}/${filePath}`,
        })
      : null;
    lspHandleRef.current = lspRegistration;

    /**
     * Autocomplete, on the same terms as the two registrations above: once,
     * for the editor's lifetime, delegating through a ref. `null` leaves the
     * suggest widget with no provider, which is what a surface with no
     * session context should do.
     */
    const completionRegistration = completionRef.current
      ? registerCompletionProvider(
          {
            current: () => completionRef.current?.current() ?? null,
            languages: completionRef.current.languages,
            requestCompletion: async (request) =>
              (await completionRef.current?.requestCompletion(request)) ?? null,
            resolveCompletion: async (request) =>
              (await completionRef.current?.resolveCompletion(request)) ?? null,
            toWorkspacePath: (projectPath, filePath) =>
              completionRef.current?.toWorkspacePath(projectPath, filePath) ??
              `${projectPath}/${filePath}`,
          },
          // For the blank-line JSX trigger, which Monaco's own suggest
          // model will not fire — see `registerBlankLineTrigger`.
          editor,
        )
      : null;

    return () => {
      changeSubscription.dispose();
      explain.dispose();
      visualize.dispose();
      definitionRegistration?.dispose();
      if (lspSyncTimeoutRef.current) clearTimeout(lspSyncTimeoutRef.current);
      // Every file this bridge was ever told about, not only the one on
      // screen when the panel closed — `modelsRef` holds one Monaco model per
      // path visited, and the language server should not be left thinking
      // any of them are still open.
      for (const { path: openPath, project: openProject } of lspOpened.values()) {
        lspRef.current?.notifyClose(openPath, openProject);
      }
      lspOpened.clear();
      lspRegistration?.dispose();
      lspHandleRef.current = null;
      completionRegistration?.dispose();
      accessLabelsRef.current?.dispose();
      commentWidgetsRef.current?.dispose();
      hunkGlyphsRef.current?.dispose();
      editor.dispose();
      models.forEach((model) => model.dispose());
      models.clear();
      editorRef.current = null;
      decorationsRef.current = null;
      accessRef.current = null;
      hunkGlyphsRef.current = null;
      accessLabelsRef.current = null;
      commentWidgetsRef.current = null;
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

    // Tell the language server what is open, and show whatever it has
    // already said about this file — both idempotent, so re-running this on
    // every `value` change (staging, say) costs a redundant `didChange`
    // rather than a bug.
    //
    // Gated on language, same reason as the debounced `didChange` above: this
    // is the call that opens a file with the server for the first time, and a
    // file outside `lsp.languages` should never reach it at all.
    if (lspRef.current?.languages.includes(languageForPath(path))) {
      lspOpenedRef.current.set(workspacePath, { path, project });
      lspRef.current.notifySync(path, project, model.getValue());
    }
    lspHandleRef.current?.applyDiagnostics(workspacePath);
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

  /**
   * The keyboard cursor's hunk, tinted more strongly than the rest of the
   * diff so it is obvious which one `w`/`s`/space is about to act on.
   *
   * A whole-line decoration over the hunk's own changed-line span —
   * `hunkChangedLineRange`, the same span the stage/unstage bracket widget
   * brackets — rather than the hunk's full `-U3` context: the emphasis is
   * about *which change*, and highlighting three lines of unchanged context
   * on either side would blur that back into "this general area", which the
   * ordinary diff wash already says.
   *
   * Its own collection (`currentHunkRef`) and its own effect, keyed on
   * `currentHunk` rather than folded into the decorations effect above: the
   * cursor moves far more often than the hunks themselves change, and giving
   * it a separate `set()` means a keypress recomputes only this, not the
   * whole diff's decorations.
   */
  useEffect(() => {
    const editor = editorRef.current;
    const collection = currentHunkRef.current;
    const model = editor?.getModel();
    if (!editor || !collection || !model) return;

    if (!currentHunk) {
      collection.set([]);
      return;
    }

    const lineCount = model.getLineCount();
    const clamp = (line: number) => Math.min(Math.max(1, line), lineCount);
    const range = hunkChangedLineRange(currentHunk);
    const startLine = clamp(range.start);
    const endLine = clamp(range.end);

    collection.set([
      {
        options: {
          className: "semla-review-current-hunk",
          isWholeLine: true,
          overviewRuler: {
            color: "var(--primary)",
            position: monaco.editor.OverviewRulerLane.Full,
          },
        },
        range: new monaco.Range(
          startLine,
          1,
          endLine,
          model.getLineMaxColumn(endLine),
        ),
      },
    ]);
  }, [currentHunk]);

  /**
   * Mark the lines the agent read or wrote, and fade the lines it did not.
   *
   * A gutter stripe and a faint wash rather than anything stronger: this sits
   * on top of the diff colours, and a read of a file the turn also changed must
   * not obscure what changed about it.
   *
   * A range whose `end` is null ran to the end of the file *at the time*, so it
   * is clamped to the model's current length — the same clamp the diff
   * decorations need, and for the same reason: an out-of-range decoration is a
   * thrown error in Monaco.
   */
  useEffect(() => {
    const editor = editorRef.current;
    const collection = accessRef.current;
    const model = editor?.getModel();
    if (!editor || !collection || !model) return;

    const modelLineCount = model.getLineCount();

    /*
     * The labels are set before the early return below, because a whole-file
     * access highlights nothing and so is the one case where the chip is the
     * *only* mark saying the agent touched this file at all.
     */
    accessLabelsRef.current?.set(buildAccessLabels(access, modelLineCount));

    if (!access || access.ranges.length === 0) {
      collection.set([]);
      return;
    }

    const lineCount = modelLineCount;
    const clamp = (line: number) => Math.min(Math.max(1, line), lineCount);
    const className =
      access.kind === "write"
        ? "semla-access-write-line"
        : "semla-access-read-line";
    const hover = access.inferred
      ? `${access.kind === "write" ? "Written" : "Read"} by the agent — inferred from a shell command`
      : `${access.kind === "write" ? "Written" : "Read"} by the agent`;

    const lineRange = (range: { start: number; end: number | null }) =>
      new monaco.Range(
        clamp(range.start),
        1,
        clamp(range.end ?? lineCount),
        model.getLineMaxColumn(clamp(range.end ?? lineCount)),
      );

    /**
     * Everything the agent did *not* read, faded back.
     *
     * The band alone says which lines were read; fading the rest says what the
     * agent was working from, which is the question the scrubber exists to
     * answer. `inlineClassName` rather than `className` because the target is
     * the text: `className` paints a block behind the line, and putting
     * `opacity` on that would fade the highlight rather than the code.
     *
     * Reads only. A write's ranges are a single `firstChangedLine`, so the
     * complement is the entire file bar one line — and the diff wash is
     * already saying what changed, in a vocabulary this would fight with.
     */
    const dimmed =
      access.kind === "read"
        ? linesOutside(access.ranges, lineCount).map((range) => ({
            options: { inlineClassName: "semla-access-dimmed" },
            range: lineRange(range),
          }))
        : [];

    collection.set([
      ...access.ranges.map((range) => ({
        options: {
          className,
          hoverMessage: { value: hover },
          isWholeLine: true,
          linesDecorationsClassName:
            access.kind === "write"
              ? "semla-access-write-gutter"
              : "semla-access-read-gutter",
        },
        range: lineRange(range),
      })),
      ...dimmed,
    ]);
  }, [access, path]);

  /**
   * Draw the agent's own comments, above the ranges they explain.
   *
   * A separate effect from every other one here, for the reason each of
   * them already gives for being separate from its neighbours: comments
   * change on their own schedule (a new one arriving mid-turn, one being
   * dismissed) rather than in step with the diff, the cursor or the access
   * marks, and `set()` replaces everything in its owner wholesale.
   */
  useEffect(() => {
    const editor = editorRef.current;
    const widgets = commentWidgetsRef.current;
    const model = editor?.getModel();
    if (!editor || !widgets || !model) return;

    widgets.set(comments, model.getLineCount(), commentNavigation);
  }, [commentNavigation, comments, path]);

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
  //
  // Once per opened file, not once per `hunks` array — see `shouldAutoScroll`.
  // Staging invalidates the hunks query, and re-scrolling on the array that
  // comes back took the viewport off wherever the reader had got to.
  useEffect(() => {
    const editor = editorRef.current;
    const line = firstChangedLine(hunks);
    if (!editor || line === null) return;
    if (!shouldAutoScroll(autoScrollRef.current, path)) return;

    autoScrollRef.current.scrolledPath = path;
    editor.revealLineNearTop(line, monaco.editor.ScrollType.Immediate);
  }, [hunks, path]);

  /**
   * Asked for a specific line — a hunk row was clicked, or the panel opened
   * on a file link.
   *
   * `Immediate` rather than `Smooth`. A file link remounts the whole panel
   * (see `initialTarget` in review-panel.tsx), so the reveal is usually
   * requested on the same commit that created the editor — and there a scroll
   * animation races the editor's first layout and loses. It stops wherever it
   * had reached and nothing revives it, because this effect only re-runs when
   * `reveal` changes. A link to line 172 of a 397-line file landed on 79, one
   * to line 445 landed on 36, and the distance moved varied from click to
   * click. Files short enough to fit the viewport hid it, since revealing a
   * line already on screen scrolls nowhere.
   */
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !reveal) return;

    editor.revealLineNearTop(reveal.line, monaco.editor.ScrollType.Immediate);
    editor.setPosition({ column: 1, lineNumber: reveal.line });
  }, [reveal]);

  return <div className="h-full w-full" ref={hostRef} />;
}
