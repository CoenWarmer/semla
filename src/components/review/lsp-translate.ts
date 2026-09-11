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
