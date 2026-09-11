import { describe, expect, it } from "vitest";

import {
  diagnosticToMarker,
  hoverContentsToMarkdown,
  toMarkerSeverity,
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
