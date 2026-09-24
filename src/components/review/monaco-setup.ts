/**
 * Monaco, configured once for this application.
 *
 * Three things are deliberate here.
 *
 * **The core API, not the barrel.** `monaco-editor`'s entry point registers
 * every language it ships — around eighty — and pulls in the LSP client.
 * Importing `editor.api.js` and naming the languages this repository is
 * actually reviewed in keeps a panel that opens on demand from dragging all of
 * that behind it.
 *
 * **Contributions then have to be named too, and that is easy to miss.**
 * `editor.api.js` is the API surface and almost nothing else: it registers a
 * single contrib (`format`) and no others. Everything one thinks of as "the
 * editor" — the right-click menu, find, comment toggling, line operations,
 * bracket matching, folding — is a separate contribution module that
 * `editor.main.js` imports and `editor.api.js` does not. The symptom is not an
 * error. The editor renders, takes typing, and simply has no context menu, so
 * `addAction` registers an action into a menu that was never built. The list
 * below is the set a surface for reading and editing code needs; anything
 * requiring a language service or the web worker this panel runs without is
 * left out on purpose, and named as such.
 *
 * **It runs without web workers, and that is a choice rather than an
 * oversight.** Monaco's default `MonacoEnvironment` fetches workers from a CDN
 * path derived at runtime, which this application will not depend on to render
 * itself. Bundling them locally was tried and does not survive the toolchain:
 * Turbopack resolves `new Worker(new URL("./x.ts", import.meta.url))` as a
 * static *asset* reference and emits the TypeScript file verbatim into
 * `static/media`, so the browser would fetch a .ts and fail to run it.
 *
 * Nothing here needs one. The workers serve the language *services* —
 * diagnostics, completion, hover, formatting — and the diff computation behind
 * `DiffEditor`. This panel colours from hunks git produced and edits text; it
 * asks for none of that. Every feature that would reach for a worker is turned
 * off explicitly below and in the editor's own options, so the absence is
 * declared rather than discovered, and `getWorker` throws a message naming
 * this comment if some future feature reaches for one anyway.
 *
 * **The theme restates the palette in hex.** Monaco cannot read CSS variables
 * for its *theme* — the editor background, the gutter, token colours — so the
 * app's oklch values are converted and written out here. That is a duplication
 * with a reason, and the same one the shimmer has: a component that paints
 * outside the cascade needs the colours handed to it. If globals.css moves,
 * this moves with it.
 *
 * Review decorations are not in that set. They are ordinary DOM nodes carrying
 * a class name, so they are styled from globals.css with the variables like
 * anything else, and they follow the theme for free.
 */

import * as monaco from "monaco-editor/editor/editor.api.js";

// Editor contributions. `editor.api.js` ships none of these; without the first
// one there is no context menu for `addAction` to add to.
import "monaco-editor/editor/browser/coreCommands.js";
import "monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js";
// Cut/Copy/Paste are themselves a contrib. Without it the context menu holds
// only Semla's two items, which reads as a broken menu rather than a short one.
import "monaco-editor/editor/contrib/clipboard/browser/clipboard.js";
import "monaco-editor/editor/contrib/find/browser/findController.js";
import "monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js";
import "monaco-editor/editor/contrib/folding/browser/folding.js";
import "monaco-editor/editor/contrib/comment/browser/comment.js";
import "monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js";
import "monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js";
import "monaco-editor/editor/contrib/multicursor/browser/multicursor.js";
import "monaco-editor/editor/contrib/smartSelect/browser/smartSelect.js";
import "monaco-editor/editor/contrib/cursorUndo/browser/cursorUndo.js";
import "monaco-editor/editor/contrib/indentation/browser/indentation.js";
/*
 * Go to Definition, in two halves that are easy to mistake for one.
 *
 * `goToCommands` registers the *actions* — the menu item, F12, Alt+F12 — and
 * `link/goToDefinitionAtPosition` registers the *gesture*: the cmd/ctrl-hover
 * underline and the cmd+click itself. Importing only the first leaves a menu
 * entry that works and a cmd+click that does nothing, which reads as the
 * modifier key being broken rather than as a missing module. The peek widget
 * `goToCommands` can open lives in peekView, which is why that is here too.
 *
 * This is an exception to the exclusion list below, and it is a checked one:
 * nothing under contrib/gotoSymbol/ references `getWorker`, `EditorWorker` or
 * `editorWorkerService`, so the worker guard is not being quietly relied on to
 * look the other way. What Go to Definition needs is a DefinitionProvider,
 * and definition-provider.ts registers one backed by the server's TypeScript
 * checker — see that file for why the browser cannot answer this itself.
 */
import "monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands.js";
import "monaco-editor/editor/contrib/gotoSymbol/browser/link/goToDefinitionAtPosition.js";
import "monaco-editor/editor/contrib/peekView/browser/peekView.js";
/*
 * Hover and rename, on the same exception as `gotoSymbol` above: checked to
 * reference no `getWorker`, `EditorWorker` or `IEditorWorkerService`, so they
 * cost no worker either. What they need is a `HoverProvider` and a
 * `RenameProvider`, and `lsp-provider.ts` registers both, backed by a real
 * `tsc --lsp` process this application spawns itself (see `lsp-host.ts` for
 * why that is a second server rather than the one supi already runs for the
 * agent) rather than Monaco's own bundled TypeScript worker.
 *
 * `suggest` used to be described here as the one contrib that could not
 * follow, on the grounds that its `SuggestModel` has a hard constructor
 * dependency on `IEditorWorkerService`. The dependency is real and the
 * conclusion was wrong — see `completion-provider.ts` for the correction in
 * full. In short: `IEditorWorkerService` is registered unconditionally by
 * `codeEditorWidget.js`'s own first import, so it was already satisfiable
 * here before completion existed; and registering it starts no worker,
 * because `WorkerManager` creates its client lazily and `SuggestModel`'s only
 * use of the service (`WordDistance.create`) returns early while
 * `suggest.localityBonus` is off, which is its default.
 *
 * The `getWorker` guard below is unchanged and still load-bearing. It is what
 * makes "somebody turned `localityBonus` on" a message that names its cause
 * rather than a silent request to a CDN.
 */
import "monaco-editor/editor/contrib/hover/browser/hoverContribution.js";
import "monaco-editor/editor/contrib/rename/browser/rename.js";
/*
 * Autocomplete, in two halves like `gotoSymbol` above.
 *
 * `suggest` carries the model, the widget and the keybindings — arrow keys to
 * move, Enter/Tab to accept, Escape to dismiss — and `snippetController2` is
 * what applies an accepted item that arrives as a snippet. The controller
 * imports the snippet module regardless, so this only makes the dependency
 * visible in the import list rather than adding one.
 *
 * What the widget needs in order to have anything to show is a
 * `CompletionItemProvider`, and `completion-provider.ts` registers one backed
 * by the same `tsc --lsp` process hover and rename use.
 */
import "monaco-editor/editor/contrib/suggest/browser/suggestController.js";
import "monaco-editor/editor/contrib/snippet/browser/snippetController2.js";
// The codicon font and its styles, as a module rather than as the raw .css
// editor.main.js imports: the package's `exports` map rewrites every subpath
// to a `.js` file, so a stylesheet cannot be reached through the package name
// at all. The context menu renders codicons for submenus and checkmarks.
import "monaco-editor/features/codicon/register.js";

/*
 * Left out deliberately, each because it needs something this panel does not
 * have: parameterHints, inlayHints, codeAction, codelens, colorPicker,
 * linkedEditing and stickyScroll want a language service beyond what
 * `lsp-provider.ts` asks for; unicodeHighlighter and wordHighlighter want the
 * editor web worker. Adding one of those means answering monaco-setup's
 * worker question first — `getWorker` below throws a message saying so.
 *
 * `gotoSymbol`, hover, rename and suggest used to be on this list. Each is
 * in, above, because what it needs turned out to be answerable from the
 * server and needs no worker of its own.
 */

// The languages this repository and its neighbours are written in. Each is a
// Monarch tokenizer that runs on the main thread; adding one is a line.
import "monaco-editor/languages/definitions/typescript/register.js";
import "monaco-editor/languages/definitions/javascript/register.js";
import "monaco-editor/languages/definitions/css/register.js";
import "monaco-editor/languages/definitions/html/register.js";
import "monaco-editor/languages/definitions/markdown/register.js";
import "monaco-editor/languages/definitions/yaml/register.js";
import "monaco-editor/languages/definitions/shell/register.js";
import "monaco-editor/languages/definitions/sql/register.js";
import "monaco-editor/languages/definitions/python/register.js";
import "monaco-editor/languages/definitions/go/register.js";
import "monaco-editor/languages/definitions/rust/register.js";
import "monaco-editor/languages/definitions/xml/register.js";
import "monaco-editor/languages/definitions/dockerfile/register.js";
/*
 * JSON is not a Monarch language, and its "feature module" is not the
 * worker-free shortcut it looks like.
 *
 * `languages/features/json/register.js` — imported here in an earlier
 * version of this file for `jsonDefaults` — calls `languages.onLanguage
 * ("json", () => import("./jsonMode.js"))` at module load. That listener
 * fires the moment the *first* JSON model is created, so opening a single
 * `.json` file dynamically imports `jsonMode.js`, which imports
 * `WorkerManager`, which imports `internal/common/workers.js` — a module
 * that unconditionally imports every editor contribution this file leaves
 * out on purpose (codelens, suggest, colorPicker, dnd, codeAction,
 * inlayHints, linkedEditing, and more) as side effects, registering them
 * all with Monaco's global `EditorExtensionsRegistry`. Once registered,
 * Monaco tries to instantiate them for every editor and fails — this
 * application never sets up the workbench services (`ICodeLensCache`,
 * `ISuggestMemories`, `treeViewsDndService`) they need — and the same
 * import chain also asks for the `editorWorkerService` worker `getWorker`
 * above refuses to hand out. Setting `modeConfiguration.tokens: true` and
 * everything else `false` only controls which *providers* `jsonMode.js`
 * registers once it has loaded; it cannot stop that module's own
 * unconditional top-level imports from running. A dynamic `import()`
 * inside a listener is invisible to reading this file's import list, which
 * is why this took a running dev server and its actual served chunks to
 * find rather than the source.
 *
 * `tokenization.js` is what this file actually wants: the same scanner
 * `jsonMode.js` uses for its tokens provider, with no dependency on
 * `editor.api.js`, `WorkerManager`, or anything else. Registering the
 * language and its tokenizer directly, the same way the Monarch languages
 * above do, gets JSON its colours without ever loading `jsonMode.js`.
 */
import { createTokenizationSupport } from "monaco-editor/languages/features/json/tokenization.js";

monaco.languages.register({
  aliases: ["JSON", "json"],
  extensions: [".json", ".bowerrc", ".jshintrc", ".jscsrc", ".eslintrc", ".babelrc", ".har"],
  id: "json",
  mimetypes: ["application/json"],
});
monaco.languages.setTokensProvider("json", createTokenizationSupport(true));
// Brackets and auto-closing pairs, copied from `jsonMode.js`'s own
// `richEditConfiguration` — not imported from there, for the same reason
// `tokenization.js` is imported directly rather than through it.
monaco.languages.setLanguageConfiguration("json", {
  autoClosingPairs: [
    { close: "}", notIn: ["string"], open: "{" },
    { close: "]", notIn: ["string"], open: "[" },
    { close: '"', notIn: ["string"], open: '"' },
  ],
  brackets: [
    ["{", "}"],
    ["[", "]"],
  ],
  comments: { blockComment: ["/*", "*/"], lineComment: "//" },
  wordPattern: /(-?\d*\.\d\w*)|([^[{\]}:",\s]+)/g,
});

export const DARK_THEME = "semla-dark";
export const LIGHT_THEME = "semla-light";

/** Converted from the oklch values in src/app/globals.css. */
const DARK = {
  background: "#0c090c",
  card: "#1d161e",
  foreground: "#fafafa",
  muted: "#2a212c",
  mutedForeground: "#a89ea9",
} as const;

const LIGHT = {
  background: "#ffffff",
  border: "#e7e4e7",
  foreground: "#0c090c",
  muted: "#f3f1f3",
  mutedForeground: "#79697b",
} as const;

/**
 * Fail loudly instead of silently reaching for a CDN.
 *
 * Monaco's fallback builds a worker URL from a base path it guesses at. If a
 * feature is ever enabled that wants a worker, the symptom would be a failed
 * network request to somewhere this application never intended to talk to.
 * This turns that into a message that names the cause.
 */
function installWorkerGuard(): void {
  const scope = self as typeof self & { MonacoEnvironment?: unknown };
  if (scope.MonacoEnvironment) return;

  scope.MonacoEnvironment = {
    getWorker(_id: string, label: string): Worker {
      throw new Error(
        `Monaco asked for the "${label}" worker. The review editor is ` +
          "configured to run without workers — see monaco-setup.ts. Whatever " +
          "feature was just enabled needs one, so either turn it off again or " +
          "bundle the worker (note that Turbopack emits a `new URL` worker " +
          "entry as a raw asset, so that is not a one-liner).",
      );
    },
  };
}

let configured = false;

/**
 * Register the themes and point Monaco at its workers.
 *
 * Idempotent: the panel can open and close repeatedly, and `defineTheme` on
 * every open would be wasted work rather than an error.
 */
export function configureMonaco(): typeof monaco {
  if (configured) return monaco;
  configured = true;

  installWorkerGuard();

  monaco.editor.defineTheme(DARK_THEME, {
    base: "vs-dark",
    colors: {
      "editor.background": DARK.background,
      "editor.foreground": DARK.foreground,
      "editor.lineHighlightBackground": DARK.card,
      "editorGutter.background": DARK.background,
      "editorLineNumber.activeForeground": DARK.foreground,
      "editorLineNumber.foreground": DARK.mutedForeground,
      "editorWidget.background": DARK.card,
      "editorWidget.border": DARK.muted,
    },
    inherit: true,
    rules: [],
  });

  monaco.editor.defineTheme(LIGHT_THEME, {
    base: "vs",
    colors: {
      "editor.background": LIGHT.background,
      "editor.foreground": LIGHT.foreground,
      "editor.lineHighlightBackground": LIGHT.muted,
      "editorGutter.background": LIGHT.background,
      "editorLineNumber.activeForeground": LIGHT.foreground,
      "editorLineNumber.foreground": LIGHT.mutedForeground,
      "editorWidget.background": LIGHT.background,
      "editorWidget.border": LIGHT.border,
    },
    inherit: true,
    rules: [],
  });

  return monaco;
}

/** Monaco's language id for a path, by extension. */
export function languageForPath(path: string): string {
  const name = path.split("/").pop() ?? path;
  if (/^Dockerfile/i.test(name)) return "dockerfile";

  const extension = name.includes(".") ? name.split(".").pop()! : "";
  const byExtension: Record<string, string> = {
    css: "css",
    go: "go",
    html: "html",
    js: "javascript",
    json: "json",
    jsonc: "json",
    jsx: "javascript",
    md: "markdown",
    mjs: "javascript",
    mts: "typescript",
    py: "python",
    rs: "rust",
    sh: "shell",
    sql: "sql",
    ts: "typescript",
    tsx: "typescript",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
    zsh: "shell",
  };

  return byExtension[extension.toLowerCase()] ?? "plaintext";
}

export { monaco };
