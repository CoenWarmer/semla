/**
 * Against call-graph-fixture.ts, whose line numbers are known by hand and are
 * part of its contract — the same fixture the call graph and `enclosingSymbol`
 * are checked against, so "what is at line 21 column 53" and "what does
 * `normalise` call" cannot disagree about what they resolved.
 *
 * The cross-file and alias cases need real Semla source, because an alias is
 * exactly what a fixture in one file cannot have: `getAliasedSymbol` only has
 * something to do when the identifier came through an `import`.
 */
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { definitionAt } from "./definition.ts";

const FIXTURE = join(process.cwd(), "src/lib/code-map/call-graph-fixture.ts");
const ENCLOSING = join(process.cwd(), "src/lib/code-map/enclosing.ts");

const at = (line: number, character: number) =>
  definitionAt({ character, file: FIXTURE, line });

describe("definitionAt", () => {
  it("resolves a call within the same file to its declaration", () => {
    // Line 21 is `export const normalise = (value: string): string => trim(value);`
    // and `trim` starts at column 53. `trim` is declared on line 16.
    expect(at(21, 53)).toMatchObject({
      external: false,
      line: 16,
      name: "trim",
    });
  });

  it("resolves a call made inside a callback", () => {
    // Line 25, column 32: `normalise` inside `values.map(...)`. The callback
    // is a scope of its own, so this checks the checker was asked rather than
    // the enclosing function being guessed at.
    expect(at(25, 32)).toMatchObject({ line: 21, name: "normalise" });
  });

  it("resolves a class used as a constructor", () => {
    // Line 37, column 14: the `Pipeline` in `return new Pipeline();`. The
    // class is declared on line 28.
    expect(at(37, 14)).toMatchObject({ line: 28, name: "Pipeline" });
  });

  it("resolves a type annotation, not just a value position", () => {
    // Line 36, column 33: the `Pipeline` in `): Pipeline {`. A type reference
    // is the case a value-only resolver would miss, and in a TSX file it is
    // most of what a reader clicks.
    expect(at(36, 33)).toMatchObject({ line: 28, name: "Pipeline" });
  });

  it("returns null on an identifier that is its own declaration", () => {
    // Line 16, column 17 is the `trim` in `export function trim(...)`. Jumping
    // to where the cursor already sits reads as a click that did nothing, so
    // this reports nothing instead.
    expect(at(16, 17)).toBeNull();
  });

  it("returns null on punctuation and on a keyword", () => {
    // Only name tokens are worth a checker round-trip: the provider is called
    // on hover, not only on click.
    expect(at(17, 3)).toBeNull(); // `return` keyword
    expect(at(18, 1)).toBeNull(); // closing brace
  });

  it("follows an import alias into another file", () => {
    // enclosing.ts imports `getProjectProgram` from ./program.ts. Without
    // getAliasedSymbol this resolves to the import specifier in enclosing.ts
    // itself, which is the bug this case exists to catch.
    const found = definitionAt({
      character: 10,
      file: ENCLOSING,
      line: 25,
    });

    expect(found).toMatchObject({
      external: false,
      file: "src/lib/code-map/program.ts",
      name: "getProjectProgram",
    });
  });

  it("reports a declaration in a .d.ts as external", () => {
    // `existsSync` resolves into @types/node. Not a refusal — the caller may
    // still open it read-only — but it cannot be edited.
    const found = definitionAt({
      character: 10,
      file: ENCLOSING,
      line: 19,
    });

    expect(found).toMatchObject({ external: true, name: "existsSync" });
  });

  it("throws for a path that does not exist", () => {
    expect(() =>
      definitionAt({ character: 1, file: "no/such/file.ts", line: 1 }),
    ).toThrow(/does not exist/);
  });
});
