/**
 * Pure conversions between what the `review/lsp/*` routes answer and what
 * Monaco's providers expect.
 *
 * Kept apart from `lsp-provider.ts`, which registers those providers, for the
 * same reason `definition-provider.ts` has no test of its own: importing
 * `monaco-editor` reaches for `document` and `window`, and this repository's
 * tests run under Vitest's `node` environment with no DOM (`vitest.config.mts`
 * — see `AGENTS.md` on why nothing here bundles a browser environment for
 * tests). The conversions themselves touch neither, so they live where they
 * can actually be pinned down.
 *
 * Positions and ranges throughout this file are LSP's own — zero-based, as
 * `review/lsp/request/route.ts` and `review/lsp/diagnostics/route.ts` return
 * them — converted to Monaco's one-based form at the one function that does
 * that, `toMonacoRange`.
 */

export type LspPosition = { line: number; character: number };
export type LspRange = { start: LspPosition; end: LspPosition };

export type LspMarkupContent = { kind: "markdown" | "plaintext"; value: string };
export type LspMarkedString = string | { language: string; value: string };
export type LspHoverContents = LspMarkupContent | LspMarkedString | LspMarkedString[];
export type LspHover = { contents: LspHoverContents; range?: LspRange } | null;

export type LspDiagnostic = {
  range: LspRange;
  /** LSP's own numbering: Error 1, Warning 2, Information 3, Hint 4. */
  severity?: 1 | 2 | 3 | 4;
  message: string;
  source?: string;
  code?: string | number;
};

export type LspTextEdit = { range: LspRange; newText: string };
export type LspRenameFile = { path: string; edits: LspTextEdit[] };
export type LspReferenceLocation = { path: string; range: LspRange };

export type LspCompletionItem = {
  label: string;
  /** LSP's own numbering (Text 1 … TypeParameter 25), not Monaco's. */
  kind?: number;
  detail?: string;
  documentation?: string | LspMarkupContent;
  labelDetails?: { detail?: string; description?: string };
  sortText?: string;
  filterText?: string;
  insertText?: string;
  /** 1 is plain text, 2 is a snippet. */
  insertTextFormat?: 1 | 2;
  textEdit?: LspTextEdit;
  additionalTextEdits?: LspTextEdit[];
  data?: unknown;
};

export type LspCompletionList = {
  isIncomplete: boolean;
  items: LspCompletionItem[];
};

/** A Monaco `IRange`'s fields, without importing `monaco-editor` for the type. */
export type MonacoRangeShape = {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
};

/** A Monaco `IMarkerData`'s fields, likewise named rather than imported. */
export type MonacoMarkerShape = MonacoRangeShape & {
  message: string;
  /** Monaco's own numbering: Hint 1, Info 2, Warning 4, Error 8 — a
   *  `monaco.MarkerSeverity`, structurally, without the import. */
  severity: 1 | 2 | 4 | 8;
  source?: string;
};

export function toMonacoRange(range: LspRange): MonacoRangeShape {
  return {
    endColumn: range.end.character + 1,
    endLineNumber: range.end.line + 1,
    startColumn: range.start.character + 1,
    startLineNumber: range.start.line + 1,
  };
}

/** LSP's `DiagnosticSeverity` (1–4) to Monaco's `MarkerSeverity` (1, 2, 4, 8). */
export function toMarkerSeverity(severity: LspDiagnostic["severity"]): MonacoMarkerShape["severity"] {
  switch (severity) {
    case 2:
      return 4; // Warning
    case 3:
      return 2; // Info
    case 4:
      return 1; // Hint
    case 1:
    default:
      return 8; // Error — LSP's default when a server omits severity entirely.
  }
}

export function diagnosticToMarker(diagnostic: LspDiagnostic): MonacoMarkerShape {
  return {
    ...toMonacoRange(diagnostic.range),
    message: diagnostic.message,
    severity: toMarkerSeverity(diagnostic.severity),
    source: diagnostic.source,
  };
}

/**
 * LSP's `CompletionItemKind` to Monaco's, which are two different numberings
 * of the same list and not off-by-one variants of each other.
 *
 * LSP starts at `Text = 1` and ends at `TypeParameter = 25`; Monaco starts at
 * `Method = 0`, orders the middle differently, and carries four kinds LSP has
 * no name for. Getting this wrong is not a crash — it is the wrong icon
 * beside every suggestion, which is exactly the sort of thing that reads as
 * the feature being broken rather than as a lookup table being off.
 *
 * Monaco's numbering is taken from its own `CompletionItemKind` enum
 * (`editor.api.d.ts`) and restated here rather than imported, for the reason
 * this whole module exists: `monaco-editor` reaches for `document` on import,
 * and these conversions are meant to be testable without a DOM.
 */
const MONACO_KIND_FOR_LSP_KIND: Record<number, number> = {
  1: 18, // Text
  2: 0, // Method
  3: 1, // Function
  4: 2, // Constructor
  5: 3, // Field
  6: 4, // Variable
  7: 5, // Class
  8: 7, // Interface
  9: 8, // Module
  10: 9, // Property
  11: 12, // Unit
  12: 13, // Value
  13: 15, // Enum
  14: 17, // Keyword
  15: 28, // Snippet
  16: 19, // Color
  17: 20, // File
  18: 21, // Reference
  19: 23, // Folder
  20: 16, // EnumMember
  21: 14, // Constant
  22: 6, // Struct
  23: 10, // Event
  24: 11, // Operator
  25: 24, // TypeParameter
};

/** Monaco's `Property` (9), the least misleading icon for an unknown kind. */
const MONACO_KIND_FALLBACK = 9;

export function toMonacoCompletionKind(kind: number | undefined): number {
  if (kind === undefined) return MONACO_KIND_FALLBACK;
  return MONACO_KIND_FOR_LSP_KIND[kind] ?? MONACO_KIND_FALLBACK;
}

/**
 * The text a completion actually inserts.
 *
 * `label` is for reading and `insertText` is for typing, and TS 7 relies on
 * the distinction in the JSX case this feature was asked for: an optional prop
 * is labelled `size?` and inserts `size`. Inserting the label there would put
 * a stray `?` into the source.
 */
export function completionInsertText(item: LspCompletionItem): string {
  return item.insertText ?? item.textEdit?.newText ?? item.label;
}

/**
 * What the suggestion list shows to the right of the label.
 *
 * `labelDetails.description` is where TS 7 puts the module an auto-import
 * would come from, and before resolve it is the *only* sign that accepting a
 * suggestion will also add an import line: `detail` arrives as
 * `Add import from "./x"` but only on the resolved item, which is one round
 * trip too late to render the list. Showing the specifier is what makes the
 * two kinds of suggestion distinguishable at a glance.
 */
export function completionDetail(item: LspCompletionItem): string | undefined {
  return item.labelDetails?.description ?? item.detail;
}

/**
 * Whether accepting this item would also add an import line.
 *
 * `labelDetails.description` is the module specifier, which TS 7 sets on
 * exactly the items that carry an auto-import — and only on those. It is the
 * same field `completionDetail` renders.
 */
export function isAutoImportItem(item: LspCompletionItem): boolean {
  return item.labelDetails?.description !== undefined;
}

/**
 * The list to show, and whether Monaco should come back for more.
 *
 * **With no prefix typed, auto-import candidates are dead weight — and they
 * are 69/70ths of the payload.** At `cost={` TS 7 answers with everything
 * nameable: 31,082 items and 11.77 MB of JSON on this repository, of which
 * 30,010 are auto-imports from every module in the dependency graph. Dropping
 * those leaves 1,072 items and 0.17 MB, and loses nothing the operator could
 * be choosing — an auto-import is a name they have not typed, and they cannot
 * pick it out of a list they have not filtered. What remains is what is
 * genuinely in scope: locals, parameters, this file's imports, and globals
 * like `window` and `console`.
 *
 * **`incomplete` is what makes that narrowing temporary.** `SuggestModel`
 * re-triggers a provider whose last list was incomplete as soon as the cursor
 * moves right onto a word, so the full list — auto-imports included — arrives
 * on the first keystroke. Without the flag, opening with `{` would leave the
 * in-scope-only list in place for the whole session, with Monaco filtering
 * that stale copy instead of asking again.
 */
export function narrowCompletions(answer: LspCompletionList, hasPrefix: boolean) {
  if (hasPrefix) {
    return { incomplete: answer.isIncomplete, items: answer.items };
  }

  return {
    incomplete: true,
    items: answer.items.filter((item) => !isAutoImportItem(item)),
  };
}

/**
 * A hover's contents, flattened to one Markdown string.
 *
 * `Hover.contents` is one of LSP's oldest, messiest shapes: plain text, a
 * single `MarkedString` (a bare string, or `{ language, value }` for a code
 * block predating `MarkupContent`), or an array of either. Every branch ends
 * up as Markdown because Monaco's own hover widget renders exactly that.
 */
export function hoverContentsToMarkdown(contents: LspHoverContents): string {
  if (typeof contents === "string") return contents;

  if (Array.isArray(contents)) {
    return contents.map(hoverContentsToMarkdown).filter(Boolean).join("\n\n");
  }

  if ("kind" in contents) return contents.value;

  return "```" + contents.language + "\n" + contents.value + "\n```";
}
