import { describe, expect, it } from "vitest";

import {
  completionDetail,
  completionInsertText,
  diagnosticToMarker,
  hoverContentsToMarkdown,
  isAutoImportItem,
  narrowCompletions,
  toMarkerSeverity,
  toMonacoCompletionKind,
  toMonacoRange,
  type LspRange,
} from "@/components/review/lsp-translate";

const range = (
  startLine: number,
  startChar: number,
  endLine: number,
  endChar: number,
): LspRange => ({
  end: { character: endChar, line: endLine },
  start: { character: startChar, line: startLine },
});

describe("toMonacoRange", () => {
  it("shifts LSP's zero-based position to Monaco's one-based one", () => {
    expect(toMonacoRange(range(0, 0, 0, 5))).toEqual({
      endColumn: 6,
      endLineNumber: 1,
      startColumn: 1,
      startLineNumber: 1,
    });
  });

  it("carries a multi-line range through unchanged in shape", () => {
    expect(toMonacoRange(range(9, 4, 12, 0))).toEqual({
      endColumn: 1,
      endLineNumber: 13,
      startColumn: 5,
      startLineNumber: 10,
    });
  });
});

describe("toMarkerSeverity", () => {
  it("maps every LSP severity to Monaco's own numbering", () => {
    // LSP: Error 1, Warning 2, Information 3, Hint 4.
    // Monaco: Hint 1, Info 2, Warning 4, Error 8.
    expect(toMarkerSeverity(1)).toBe(8);
    expect(toMarkerSeverity(2)).toBe(4);
    expect(toMarkerSeverity(3)).toBe(2);
    expect(toMarkerSeverity(4)).toBe(1);
  });

  it("treats a missing severity as an error, LSP's own default", () => {
    expect(toMarkerSeverity(undefined)).toBe(8);
  });
});

describe("diagnosticToMarker", () => {
  it("combines the range and the severity into one marker", () => {
    expect(
      diagnosticToMarker({
        message: "Cannot find name 'foo'.",
        range: range(3, 2, 3, 5),
        severity: 1,
      }),
    ).toEqual({
      endColumn: 6,
      endLineNumber: 4,
      message: "Cannot find name 'foo'.",
      severity: 8,
      source: undefined,
      startColumn: 3,
      startLineNumber: 4,
    });
  });

  it("keeps the source, when the server sent one", () => {
    const marker = diagnosticToMarker({
      message: "Unused variable.",
      range: range(0, 0, 0, 1),
      severity: 2,
      source: "ts",
    });
    expect(marker.source).toBe("ts");
  });
});

describe("hoverContentsToMarkdown", () => {
  it("passes a plain string through", () => {
    expect(hoverContentsToMarkdown("just text")).toBe("just text");
  });

  it("takes the value out of MarkupContent", () => {
    expect(hoverContentsToMarkdown({ kind: "markdown", value: "**bold**" })).toBe(
      "**bold**",
    );
  });

  it("fences a MarkedString object as a code block", () => {
    expect(
      hoverContentsToMarkdown({ language: "typescript", value: "const x: string" }),
    ).toBe("```typescript\nconst x: string\n```");
  });

  it("joins an array of mixed contents with a blank line between", () => {
    expect(
      hoverContentsToMarkdown([
        { language: "typescript", value: "function f(): void" },
        "A doc comment.",
      ]),
    ).toBe("```typescript\nfunction f(): void\n```\n\nA doc comment.");
  });

  it("drops empty entries rather than leaving a stray blank line", () => {
    expect(hoverContentsToMarkdown(["", "real content", ""])).toBe("real content");
  });
});

describe("toMonacoCompletionKind", () => {
  /*
   * The two numberings are not offset variants of one another, so the
   * interesting cases are the ones where they disagree about order rather
   * than the endpoints.
   */
  it("remaps LSP's numbering onto Monaco's", () => {
    expect(toMonacoCompletionKind(1)).toBe(18); // Text
    expect(toMonacoCompletionKind(3)).toBe(1); // Function
    expect(toMonacoCompletionKind(5)).toBe(3); // Field
    expect(toMonacoCompletionKind(7)).toBe(5); // Class
    expect(toMonacoCompletionKind(21)).toBe(14); // Constant
    expect(toMonacoCompletionKind(25)).toBe(24); // TypeParameter
  });

  it("maps the two kinds this feature actually produces", () => {
    // A JSX prop arrives as Field (5); an auto-imported class as Class (7).
    expect(toMonacoCompletionKind(5)).toBe(3);
    expect(toMonacoCompletionKind(7)).toBe(5);
  });

  it("falls back to Property for a missing or unknown kind", () => {
    expect(toMonacoCompletionKind(undefined)).toBe(9);
    expect(toMonacoCompletionKind(99)).toBe(9);
  });
});

describe("completionInsertText", () => {
  it("prefers insertText, which is what strips a prop's trailing ?", () => {
    // TS 7's own answer for a JSX attribute: label reads, insertText types.
    expect(
      completionInsertText({ insertText: "size", label: "size?" }),
    ).toBe("size");
  });

  it("falls back to the label when there is no insertText", () => {
    // An auto-import item arrives with neither insertText nor a textEdit.
    expect(completionInsertText({ label: "ReviewCommentWidgets" })).toBe(
      "ReviewCommentWidgets",
    );
  });

  it("takes a textEdit's newText over the label", () => {
    expect(
      completionInsertText({
        label: "shown",
        textEdit: {
          newText: "typed",
          range: {
            end: { character: 0, line: 0 },
            start: { character: 0, line: 0 },
          },
        },
      }),
    ).toBe("typed");
  });
});

describe("completionDetail", () => {
  it("prefers the module specifier an unresolved auto-import carries", () => {
    expect(
      completionDetail({
        detail: 'Add import from "./review-comment-widgets"',
        label: "ReviewCommentWidgets",
        labelDetails: { description: "./review-comment-widgets" },
      }),
    ).toBe("./review-comment-widgets");
  });

  it("falls back to detail when there are no label details", () => {
    expect(completionDetail({ detail: "string", label: "size" })).toBe(
      "string",
    );
  });

  it("is undefined when the item says nothing either way", () => {
    expect(completionDetail({ label: "size" })).toBeUndefined();
  });
});

describe("isAutoImportItem", () => {
  it("is true only when a module specifier is attached", () => {
    // TS 7 sets labelDetails.description to the module on exactly the items
    // whose acceptance would add an import line.
    expect(
      isAutoImportItem({
        label: "ReviewCommentWidgets",
        labelDetails: { description: "./review-comment-widgets" },
      }),
    ).toBe(true);
  });

  it("is false for something already in scope", () => {
    expect(isAutoImportItem({ label: "localCount" })).toBe(false);
    // A `detail` alone is a type signature, not an import.
    expect(
      isAutoImportItem({ detail: "const localCount: 1", label: "localCount" }),
    ).toBe(false);
  });
});

describe("narrowCompletions", () => {
  const inScope = { detail: "const localCount: 1", label: "localCount" };
  const global = { label: "window" };
  const autoImport = {
    label: "Button",
    labelDetails: { description: "@/components/ui/button" },
  };
  const answer = {
    isIncomplete: false,
    items: [inScope, global, autoImport],
  };

  /*
   * The `cost={` case. Auto-imports are ~69/70ths of the payload here
   * (11.77 MB -> 0.17 MB measured) and cannot be what the operator is picking,
   * since they have typed nothing to filter by.
   */
  it("drops auto-imports when nothing has been typed", () => {
    const result = narrowCompletions(answer, false);

    expect(result.items).toEqual([inScope, global]);
  });

  it("keeps what is genuinely in scope, including globals", () => {
    const result = narrowCompletions(answer, false);

    expect(result.items.map((item) => item.label)).toContain("localCount");
    expect(result.items.map((item) => item.label)).toContain("window");
  });

  /*
   * Without this flag the narrowed list would persist for the whole session:
   * SuggestModel only re-queries a provider whose previous list was
   * incomplete, so the auto-imports would never arrive.
   */
  it("marks a narrowed list incomplete so Monaco re-queries", () => {
    expect(narrowCompletions(answer, false).incomplete).toBe(true);
  });

  it("returns everything untouched once a prefix exists", () => {
    const result = narrowCompletions(answer, true);

    expect(result.items).toEqual([inScope, global, autoImport]);
    expect(result.incomplete).toBe(false);
  });

  it("respects the server's own isIncomplete when there is a prefix", () => {
    expect(
      narrowCompletions({ isIncomplete: true, items: [inScope] }, true)
        .incomplete,
    ).toBe(true);
  });
});
