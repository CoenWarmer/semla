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
// JSON is not a Monarch language: it has its own feature module.
import { jsonDefaults } from "monaco-editor/languages/features/json/register.js";

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

  // Diagnostics off: this is a review surface, not an editor with a linter.
  // Schema validation on a package.json would report problems that are not
  // what the operator opened the panel to look at.
  jsonDefaults.setDiagnosticsOptions({
    ...jsonDefaults.diagnosticsOptions,
    enableSchemaRequest: false,
    validate: false,
  });

  // Tokenization only. It runs on the main thread off the jsonc-parser
  // scanner, so JSON keeps its colours; every other adapter in the JSON mode
  // is worker-backed and would spawn one on first use.
  jsonDefaults.setModeConfiguration({
    colors: false,
    completionItems: false,
    diagnostics: false,
    documentFormattingEdits: false,
    documentRangeFormattingEdits: false,
    documentSymbols: false,
    foldingRanges: false,
    hovers: false,
    selectionRanges: false,
    tokens: true,
  });

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
