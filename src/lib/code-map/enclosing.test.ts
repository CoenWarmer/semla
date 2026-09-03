/**
 * Against call-graph-fixture.ts, whose structure and line numbers are known by
 * hand — the same fixture the call graph is checked against, so "which
 * function is line 31 in" and "what does Pipeline.run call" cannot disagree
 * about what a callable is.
 */
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { enclosingSymbol } from "./enclosing.ts";

const FIXTURE = join(process.cwd(), "src/lib/code-map/call-graph-fixture.ts");

const at = (line: number) => enclosingSymbol({ file: FIXTURE, line });

describe("enclosingSymbol", () => {
  it("finds a plain function from a line in its body", () => {
    // `trim` spans 16–18.
    expect(at(17)).toMatchObject({
      container: null,
      endLine: 18,
      name: "trim",
      startLine: 16,
      symbol: "trim",
    });
  });

  it("finds it from its signature line and its closing brace", () => {
    expect(at(16)?.name).toBe("trim");
    expect(at(18)?.name).toBe("trim");
  });

  it("finds an arrow function assigned to a const", () => {
    // The shape this repository actually uses most. Line 21 is the whole
    // declaration, so the range is a single line.
    expect(at(21)).toMatchObject({ name: "normalise", startLine: 21 });
  });

  it("prefers the method over the class that contains it", () => {
    // Line 31 is inside both Pipeline (28–33) and Pipeline.run (30–32). The
    // narrower one is what the reader right-clicked in.
    expect(at(31)).toMatchObject({
      container: "Pipeline",
      name: "run",
      symbol: "Pipeline.run",
    });
  });

  it("returns the class for a line in the class but in no method", () => {
    expect(at(28)?.symbol).toBe("Pipeline");
  });

  it("gives buildCodeMap a symbol it accepts, container form included", () => {
    // The contract between the two: this string is passed straight through as
    // `symbol`, so the `Container.method` spelling has to be the one findEntry
    // matches.
    expect(at(31)?.symbol).toBe("Pipeline.run");
  });

  it("is null for a line inside no function at all", () => {
    // Line 14 is blank, between the docblock and the first declaration.
    // Guessing at the nearest function would be worse than saying nothing.
    expect(at(14)).toBeNull();
  });

  it("is null for a line in the file's leading docblock", () => {
    expect(at(2)).toBeNull();
  });

  it("refuses a file that is not there, naming the resolution root", () => {
    expect(() =>
      enclosingSymbol({ cwd: "/tmp", file: "does/not/exist.ts", line: 1 }),
    ).toThrow(/does not exist/);
  });
});
