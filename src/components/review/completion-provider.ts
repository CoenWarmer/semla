/**
 * Autocomplete, backed by the same `tsc --lsp` process the rest of this
 * bridge talks to.
 *
 * Sibling to `definition-provider.ts` and `lsp-provider.ts`, built the same
 * way: one config object of callbacks, registered once against refs for the
 * editor's lifetime, so the provider Monaco holds stays stable while the
 * callbacks it calls through stay current.
 *
 * **This uses Monaco's own suggest widget, and that is a correction rather
 * than a choice.** `monaco-setup.ts` used to say `suggest` could not be
 * imported because its `SuggestModel` has a hard constructor dependency on
 * `IEditorWorkerService`, which this application runs without. The dependency
 * is real; the conclusion was wrong, in two ways:
 *
 * - `IEditorWorkerService` is registered *unconditionally*, not by the suggest
 *   contribution. `codeEditorWidget.js` — which `editor.api.js` pulls in for
 *   any editor at all — imports `browser/services/contribution.js` at its very
 *   first line, and that file calls `registerSingleton(IEditorWorkerService,
 *   EditorWorkerService, Eager)`. So the injection has always been satisfiable
 *   here; it was satisfied before this feature existed.
 * - Registering the service does not start a worker. `EditorWorkerService`'s
 *   constructor builds a `WorkerManager`, whose `_editorWorkerClient` stays
 *   null until something calls a method that needs it. `SuggestModel`'s one
 *   use is `WordDistance.create`, which returns `WordDistance.None` and
 *   touches nothing when `suggest.localityBonus` is off — and it is off by
 *   default. The service's other consumers are the link provider (`links:
 *   false` here) and word-based completions (`wordBasedSuggestions: "off"`),
 *   neither of which runs.
 *
 * Every other service `SuggestController` and `SuggestModel` inject —
 * `ISuggestMemoryService` (self-registered in `suggestMemory.js`),
 * `ICommandService`, `IContextKeyService`, `IInstantiationService`,
 * `ILogService`, `ITelemetryService`, `IClipboardService`,
 * `IEnvironmentService` — is registered by `standaloneServices.js` already.
 *
 * The worker guard in `monaco-setup.ts` stays exactly as it is. It is what
 * turns "some future option flipped `localityBonus` on" into a message naming
 * the cause instead of a silent fetch to a CDN.
 *
 * **What this file does not do is filter.** TS 7 answers a completion request
 * with every name in scope — 1093 items for a position in this repository,
 * ~190 KB of JSON — and leaves matching to the client, which is ordinary LSP.
 * Monaco's `CompletionItemProvider` contract is the same: hand over the list
 * with a `range`, and its suggest model scores, filters and re-filters against
 * what the operator types. So there is no filtering here, and deliberately no
 * debounce either — `SuggestModel` already coalesces typing, and `isIncomplete`
 * is passed through so the server can ask to be re-queried per keystroke when
 * its answer depends on the prefix.
 *
 * **Resolve is where the import line comes from.** An auto-import item arrives
 * with no edits on it at all — only a `labelDetails.description` naming the
 * module. `completionItem/resolve` is what returns the
 * `additionalTextEdits` holding `\nimport { X } from "./x";\n`, so
 * `resolveCompletionItem` is not an optimisation to skip: without it,
 * accepting a suggestion inserts the name and no import, which is the one
 * thing this feature exists to do.
 */

import type { monaco as Monaco } from "./monaco-setup";
import { monaco } from "./monaco-setup";
import { uriForWorkspacePath } from "./definition-provider";
import { isInsideOpenJsxTag } from "./jsx-attribute-position";
import {
  completionDetail,
  completionInsertText,
  narrowCompletions,
  toMonacoCompletionKind,
  toMonacoRange,
  type LspCompletionItem,
  type LspCompletionList,
} from "./lsp-translate";

export type CompletionRequest = {
  path: string;
  project: string;
  line: number;
  character: number;
  /** Set when Monaco was triggered by a character rather than an explicit invoke. */
  triggerCharacter?: string;
};

export type CompletionProviderConfig = {
  /** The file currently in the editor, so a request can be attributed. */
  current: () => { path: string; project: string } | null;
  languages: readonly string[];
  toWorkspacePath: (project: string, path: string) => string;
  requestCompletion: (
    request: CompletionRequest,
  ) => Promise<LspCompletionList | null>;
  /** Resolve one item. This is what produces its import line. */
  resolveCompletion: (
    request: { path: string; project: string; item: LspCompletionItem },
  ) => Promise<LspCompletionItem | null>;
};

/**
 * The characters that ask TS 7 a *different* question rather than merely
 * continuing a word.
 *
 * Taken from the `triggerCharacters` TS 7 advertises in its own `initialize`
 * response, minus the ones that would fire inside ordinary prose: the full set
 * includes `"`, `'`, `` ` ``, `/`, `@`, `#`, ` ` and `*`, and a space as a
 * trigger means every space in every comment opens a suggestion list.
 *
 * `.` is member access, `<` is a JSX tag. Both change what the server returns
 * for the same position, which is why they are forwarded as a
 * `TriggerCharacter` kind rather than flattened into an invoke.
 *
 * `{` is the odd one, and it is here for a reason the other two are not:
 * opening a JSX prop value (`cost={`) should offer the names in scope without
 * waiting for a first letter to be typed. It is **not** one of the characters
 * TS 7 advertises, and sending it as an LSP trigger character *panics* the
 * server (`Unknown trigger character: {`) — so `review/lsp/request/route.ts`
 * downgrades it to an explicit invoke. That is sound rather than a hack: the
 * answer for the position does not depend on `triggerKind`, which only tells
 * the server why it was asked. This being a *Monaco* trigger character and
 * not a *server* one is the whole trick.
 *
 * Words themselves need no entry here: Monaco triggers on its own as the
 * operator types an identifier, and `quickSuggestions` in `code-editor.tsx` is
 * what turns that on.
 */
const TRIGGER_CHARACTERS = [".", "<", "{"] as const;

/**
 * With no prefix typed, an auto-import suggestion is dead weight — and it is
 * 69/70ths of the payload.
 *
 * At `cost={` TS 7 answers with everything nameable: 31,082 items, **11.77 MB**
 * of JSON, of which 30,010 are auto-import candidates from every module in the
 * dependency graph. Dropping those leaves 1,072 items and 0.17 MB — measured,
 * on this repository — and loses nothing the operator could want, because an
 * auto-import is a name they have not typed yet and cannot be choosing from a
 * list they have not filtered. What survives is what is actually in scope:
 * locals, parameters, this file's imports, and the globals (`window`,
 * `console`, `Math`).
 *
 * The distinction is `labelDetails.description`, which TS sets to the module
 * specifier on exactly the items that would add an import line — the same
 * field `completionDetail` reads to render it.
 *
 * This only applies when there is no prefix. The moment a character is typed
 * the full list is wanted again (that is how auto-import completion works at
 * all), and `incomplete: true` on the narrowed answer is what makes Monaco
 * come back for it: `SuggestModel` re-triggers a provider whose last list was
 * incomplete as soon as the cursor moves right onto a word.
 *
 * The narrowing itself is `narrowCompletions` in `lsp-translate.ts`, where it
 * can be tested without a DOM — the measured figures are in its docblock.
 */

/**
 * Monaco's suggest model re-filters against the model text under `range`, so
 * the range has to be the word actually being typed — not the cursor.
 *
 * `getWordUntilPosition` is the same call Monaco's own providers use, and it
 * is trimmed to the cursor column: typing `Rev|iew` offers completions for
 * `Rev`, not for `Review`, which is what makes the list narrow as characters
 * are added rather than jumping around.
 *
 * An empty word is a legitimate position rather than a reason to bail. After a
 * `<` or a `.`, or inside a JSX tag where TS answers with props, there is no
 * prefix yet and the whole list is the answer.
 */
function replaceRange(
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
): Monaco.IRange {
  const word = model.getWordUntilPosition(position);
  return {
    endColumn: position.column,
    endLineNumber: position.lineNumber,
    startColumn: word.startColumn,
    startLineNumber: position.lineNumber,
  };
}

/**
 * Whether `model` is the file the panel currently has open.
 *
 * Same guard as `lsp-provider.ts` and for the same reason: a model built by
 * `ensureModel` to answer a Go to Definition is a real thing to have on
 * screen, but a cursor in it belongs to no project this provider can address.
 */
function isCurrentModel(
  model: Monaco.editor.ITextModel,
  config: CompletionProviderConfig,
): { path: string; project: string } | null {
  const current = config.current();
  if (!current) return null;

  const openUri = uriForWorkspacePath(
    config.toWorkspacePath(current.project, current.path),
  );
  return model.uri.toString() === openUri.toString() ? current : null;
}

/**
 * A Monaco suggestion for one LSP item.
 *
 * The original item is carried on the returned object so `resolveCompletionItem`
 * can hand it back to the server verbatim — its opaque `data` is what the
 * server matches on, and reconstructing an item from the Monaco-shaped one
 * would drop it.
 */
type CarriedSuggestion = Monaco.languages.CompletionItem & {
  /** Not Monaco's field. Read only by `resolveCompletionItem` below. */
  __lspItem: LspCompletionItem;
};

function toMonacoSuggestion(
  item: LspCompletionItem,
  range: Monaco.IRange,
): CarriedSuggestion {
  const detail = completionDetail(item);

  return {
    __lspItem: item,
    detail,
    filterText: item.filterText,
    insertText: completionInsertText(item),
    /*
     * `insertTextFormat` 2 is a snippet. TS 7 sends plain text for everything
     * this feature covers, but an item that does arrive as a snippet has to be
     * declared as one or its `$0`/`${1:x}` placeholders would be inserted
     * literally.
     */
    insertTextRules:
      item.insertTextFormat === 2
        ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
        : undefined,
    kind: toMonacoCompletionKind(item.kind),
    label: item.labelDetails?.description
      ? { description: item.labelDetails.description, label: item.label }
      : item.label,
    range,
    sortText: item.sortText,
  };
}

/**
 * Ask for suggestions on a blank line inside an open JSX tag.
 *
 * Monaco will not do this itself: `SuggestModel.shouldAutoTrigger` needs
 * `getWordAtPosition` to return a word, and a whitespace-only line has none,
 * so it bails before `quickSuggestions` is even consulted. The language
 * server answers that position correctly — the tag's remaining props, with
 * the ones already written excluded — so what is missing is only the trigger.
 *
 * **`auto: true` is what makes this safe.** `suggestWidget.js` does
 * `this._setState(isAuto ? State.Hidden : State.Empty)`, so an auto trigger
 * with nothing to show hides silently where an explicit one would say "No
 * suggestions.". A false positive from `isInsideOpenJsxTag` therefore costs
 * one wasted request and shows nothing, which is why a text scan is good
 * enough and no round trip is needed to decide.
 *
 * Bound to cursor movement rather than typing, because the position this is
 * about is reached by pressing Enter or by clicking — not by typing a
 * character on the line itself.
 */
function registerBlankLineTrigger(
  editor: Monaco.editor.ICodeEditor,
  config: CompletionProviderConfig,
): Monaco.IDisposable {
  return editor.onDidChangeCursorPosition((event) => {
    // Only a deliberate arrival. `Explicit` covers Enter, clicking and the
    // arrow keys; a cursor moved by an edit or by `revealLine` is not the
    // operator asking for anything.
    if (event.reason !== monaco.editor.CursorChangeReason.Explicit) return;

    const model = editor.getModel();
    if (!model) return;
    if (!isCurrentModel(model, config)) return;
    if (!config.languages.includes(model.getLanguageId())) return;

    /*
     * Only the tag's own attribute lines are read, not the whole file: the
     * scan looks back a bounded distance and a large model's full text would
     * be copied on every cursor move.
     */
    const line = event.position.lineNumber;
    const from = Math.max(1, line - 40);
    const lines: string[] = [];
    for (let at = from; at <= line; at += 1) lines.push(model.getLineContent(at));

    if (!isInsideOpenJsxTag({ line: lines.length - 1, lines })) return;

    editor.trigger("semla.jsxAttribute", "editor.action.triggerSuggest", {
      auto: true,
    });
  });
}

export function registerCompletionProvider(
  config: CompletionProviderConfig,
  /**
   * The editor the blank-line trigger attaches to. Optional so a caller that
   * only wants the language provider registered — a test, or a surface with no
   * editor of its own — does not have to supply one.
   */
  editor?: Monaco.editor.ICodeEditor,
): Monaco.IDisposable {
  const provider: Monaco.languages.CompletionItemProvider = {
    triggerCharacters: [...TRIGGER_CHARACTERS],

    async provideCompletionItems(model, position, context) {
      const current = isCurrentModel(model, config);
      if (!current) return null;

      const answer = await config.requestCompletion({
        character: position.column,
        line: position.lineNumber,
        path: current.path,
        project: current.project,
        triggerCharacter: context.triggerCharacter,
      });
      if (!answer) return null;

      const range = replaceRange(model, position);

      /*
       * Whether the operator has typed anything for this suggestion yet.
       * `replaceRange` is trimmed to the cursor, so an empty span is exactly
       * "no prefix" — the `cost={` case, and equally a bare `.` or `<`.
       */
      const hasPrefix = range.endColumn > range.startColumn;
      const narrowed = narrowCompletions(answer, hasPrefix);

      return {
        incomplete: narrowed.incomplete,
        suggestions: narrowed.items.map((item) =>
          toMonacoSuggestion(item, range),
        ),
      };
    },

    /**
     * Ask the server about the one item the operator has settled on.
     *
     * Monaco calls this when a suggestion is focused, before it is accepted,
     * and merges what comes back into the item it already holds. For an
     * auto-import that means `additionalTextEdits` — the import line — arrives
     * in time for `insertText` and the import to be applied as a single
     * undoable edit by Monaco's own accept path. Nothing here writes to the
     * model.
     */
    async resolveCompletionItem(item) {
      const carried = (item as CarriedSuggestion).__lspItem;
      const current = config.current();
      if (!carried || !current) return item;

      const resolved = await config.resolveCompletion({
        item: carried,
        path: current.path,
        project: current.project,
      });
      if (!resolved) return item;

      return {
        ...item,
        additionalTextEdits: resolved.additionalTextEdits?.map((edit) => ({
          range: toMonacoRange(edit.range),
          text: edit.newText,
        })),
        /*
         * The resolved `detail` is the human sentence — `Add import from
         * "./x"` — where the unresolved item only had the bare specifier, so
         * it is worth taking. `documentation` only exists after resolve.
         */
        detail: resolved.detail ?? item.detail,
        documentation:
          typeof resolved.documentation === "string"
            ? resolved.documentation
            : resolved.documentation?.value
              ? { value: resolved.documentation.value }
              : item.documentation,
      };
    },
  };

  const disposables: Monaco.IDisposable[] = config.languages.map((language) =>
    monaco.languages.registerCompletionItemProvider(language, provider),
  );

  if (editor) disposables.push(registerBlankLineTrigger(editor, config));

  return {
    dispose() {
      for (const disposable of disposables) disposable.dispose();
    },
  };
}
