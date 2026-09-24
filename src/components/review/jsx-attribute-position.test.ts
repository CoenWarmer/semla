import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { isInsideOpenJsxTag } from "@/components/review/jsx-attribute-position";

/** The cursor is on the last line, which is the case this predicate is about. */
const probe = (source: string) => {
  const lines = source.split("\n");
  return isInsideOpenJsxTag({ line: lines.length - 1, lines });
};

describe("isInsideOpenJsxTag", () => {
  it("is true for the operator's own reported shape", () => {
    // A closed tag, props already supplied, cursor on its own blank line.
    expect(
      probe(
        [
          "      <SessionProjectPicker",
          "        linkedPaths={new Set(projects.map((project) => project.path))}",
          "        sessionId={sessionId}",
          "        ",
        ].join("\n"),
      ),
    ).toBe(true);
  });

  it("is true directly under the opening tag", () => {
    expect(probe("      <Button\n        ")).toBe(true);
  });

  it("is true for a namespaced or dotted element name", () => {
    expect(probe("  <Foo.Bar\n    ")).toBe(true);
    expect(probe("  <svg:rect\n    ")).toBe(true);
  });

  it("looks past a comment between attributes", () => {
    expect(
      probe(
        [
          "  <Button",
          "    variant=\"ghost\"",
          "    // TODO: also pass a className",
          "    ",
        ].join("\n"),
      ),
    ).toBe(true);
  });

  /*
   * The refusals matter more than the acceptances: a wrong `true` costs a
   * silent wasted request, but a wrong `true` that also fires inside ordinary
   * code would make the editor feel unpredictable.
   */
  it("is false once the tag is closed", () => {
    expect(probe("  <Button\n    variant=\"ghost\"\n  />\n  ")).toBe(false);
    expect(probe("  <Button variant=\"ghost\">\n    ")).toBe(false);
    expect(probe("  <div>\n    ")).toBe(false);
  });

  it("is false for a self-closing tag written on one line", () => {
    expect(probe("  <Button variant=\"ghost\" />\n  ")).toBe(false);
  });

  it("is false after a closing tag", () => {
    expect(probe("  </Button>\n  ")).toBe(false);
  });

  it("is false for a comparison that only looks like a tag", () => {
    // `a < b` — the name matches, but an identifier precedes the `<`.
    expect(probe("  const ok = a < b\n  ")).toBe(false);
    expect(probe("  if (count < max)\n  ")).toBe(false);
    expect(probe("  const n = fn() < other\n  ")).toBe(false);
  });

  it("is false when the line has any content of its own", () => {
    // Monaco triggers on its own wherever there is a word; this must not
    // double up on the same keystroke.
    expect(probe("  <Button\n    va")).toBe(false);
    expect(probe("  <Button\n    variant=\"x\"")).toBe(false);
  });

  it("is false in plain code with no tag above", () => {
    expect(probe("function x() {\n  const a = 1;\n  ")).toBe(false);
  });

  it("is false when nothing precedes the cursor at all", () => {
    expect(probe("  ")).toBe(false);
    expect(isInsideOpenJsxTag({ line: 0, lines: [] })).toBe(false);
  });

  it("gives up rather than scanning an unbounded distance", () => {
    // 40 lines of lookback; an opening tag beyond that is not found.
    const far = ["  <Button", ...Array.from({ length: 45 }, () => "    x={1}"), "    "];
    expect(isInsideOpenJsxTag({ line: far.length - 1, lines: far })).toBe(false);
  });
});

/**
 * Against a real call site rather than a transcription of one.
 *
 * A live `tsc --lsp` answers a tag's *remaining* props at exactly this kind
 * of position, with the ones already written excluded. This half asserts the
 * trigger agrees, so the two cannot drift apart: a scan that stopped firing
 * here would still pass every synthetic case above.
 *
 * `<GitStatusBadge>` is the fixture because its attribute list spans several
 * lines and carries a line comment between attributes, which is the one
 * branch of the backward scan a synthetic case is most likely to miss.
 */
describe("the real <GitStatusBadge> call site", () => {
  const headerActions = () =>
    readFileSync(
      path.join(process.cwd(), "src/components/session/header-actions.tsx"),
      "utf8",
    ).split("\n");

  it("fires on a blank line after the last supplied prop", () => {
    const original = headerActions();
    const anchor = original.findIndex((line) =>
      line.includes("target={{ kind: \"session\""),
    );
    expect(anchor).toBeGreaterThan(-1);

    const lines = [
      ...original.slice(0, anchor + 1),
      "        ",
      ...original.slice(anchor + 1),
    ];

    expect(isInsideOpenJsxTag({ line: anchor + 1, lines })).toBe(true);
  });

  it("does not fire on the tag's own closing line", () => {
    const lines = headerActions();
    const closing = lines.findIndex((line) => line.trim() === "/>");
    expect(closing).toBeGreaterThan(-1);
    expect(isInsideOpenJsxTag({ line: closing, lines })).toBe(false);
  });
});
