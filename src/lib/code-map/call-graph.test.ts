/**
 * These tests are the claim the whole feature rests on: that an edge in a code
 * map corresponds to a call that is really there, at the line it says.
 *
 * So they assert against call-graph-fixture.ts, whose structure is known by
 * hand, and they check the *line numbers* rather than only the shape. A test
 * that accepted any line would pass just as happily on a graph that had
 * resolved the wrong declarations.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildCodeMap, SymbolNotFoundError } from "./call-graph.ts";
import type { CodeMap } from "./types.ts";

const FIXTURE = join(process.cwd(), "src/lib/code-map/call-graph-fixture.ts");

const node = (map: CodeMap, name: string) =>
  map.nodes.find((candidate) => candidate.name === name);

const edge = (map: CodeMap, from: string, to: string) => {
  const source = node(map, from);
  const target = node(map, to);
  if (!source || !target) return undefined;
  return map.edges.find(
    (candidate) => candidate.from === source.id && candidate.to === target.id,
  );
};

/**
 * The line a call actually appears on, read back from the fixture itself.
 *
 * Reading it rather than hard-coding means editing the fixture cannot make these
 * assertions quietly meaningless — they still compare the map against the file.
 */
const fixtureLines = readFileSync(FIXTURE, "utf8").split("\n");
const lineContaining = (needle: string) =>
  fixtureLines.findIndex((line) => line.includes(needle)) + 1;

describe("buildCodeMap", () => {
  it("resolves a call through an arrow function held in a const", () => {
    const map = buildCodeMap({ file: FIXTURE, symbol: "normaliseAll" });

    // normaliseAll -> normalise -> trim, both resolved by the checker.
    expect(edge(map, "normaliseAll", "normalise")).toBeDefined();
    expect(edge(map, "normalise", "trim")).toBeDefined();

    // The arrow's node is named for the const, which is what a reader calls it.
    expect(node(map, "normalise")?.kind).toBe("function");
  });

  it("cites the line the call is actually on", () => {
    const map = buildCodeMap({ file: FIXTURE, symbol: "normaliseAll" });

    expect(edge(map, "normaliseAll", "normalise")?.sites).toEqual([
      lineContaining("values.map((value) => normalise(value))"),
    ]);
    expect(edge(map, "normalise", "trim")?.sites).toEqual([
      lineContaining("export const normalise"),
    ]);
  });

  it("attributes a call made inside a callback to the enclosing function", () => {
    const map = buildCodeMap({ file: FIXTURE, symbol: "normaliseAll" });

    // normalise is called from inside the arrow passed to .map, not from
    // normaliseAll's own statement list.
    expect(edge(map, "normaliseAll", "normalise")).toBeDefined();
  });

  it("leaves the standard library out unless it is asked for", () => {
    const map = buildCodeMap({ file: FIXTURE, symbol: "normaliseAll" });

    // Array.prototype.map is called here, but a map of "how this code flows"
    // that is three-quarters stdlib is not answering the question.
    expect(map.nodes.every((candidate) => !candidate.external)).toBe(true);
    expect(node(map, "map")).toBeUndefined();
  });

  it("keeps the standard library as a boundary it does not walk into", () => {
    const map = buildCodeMap({
      file: FIXTURE,
      includeExternal: true,
      symbol: "normaliseAll",
    });

    const arrayMap = node(map, "map");
    expect(arrayMap?.external).toBe(true);
    expect(arrayMap?.kind).toBe("external");
    expect(map.edges.some((candidate) => candidate.from === arrayMap?.id)).toBe(
      false,
    );
  });

  it("records a method and the class that contains it", () => {
    const map = buildCodeMap({ file: FIXTURE, symbol: "Pipeline.run" });

    expect(node(map, "run")?.kind).toBe("method");
    expect(node(map, "run")?.container).toBe("Pipeline");
    expect(edge(map, "run", "normaliseAll")).toBeDefined();
  });

  it("distinguishes construction from a plain call", () => {
    const map = buildCodeMap({ file: FIXTURE, symbol: "makePipeline" });

    expect(edge(map, "makePipeline", "Pipeline")?.kind).toBe("new");
  });

  it("reports a call through a parameter instead of inventing a node", () => {
    const map = buildCodeMap({ file: FIXTURE, symbol: "invoke" });

    expect(map.nodes.map((n) => n.name)).not.toContain("apply");
    expect(map.unresolved).toHaveLength(1);
    expect(map.unresolved[0]).toMatchObject({
      line: lineContaining('return apply("x")'),
      name: "apply",
    });
    expect(map.unresolved[0].reason).toContain("not implemented here");
  });

  it("survives mutual recursion without looping", () => {
    const map = buildCodeMap({ depth: 5, file: FIXTURE, symbol: "ping" });

    expect(edge(map, "ping", "pong")).toBeDefined();
    expect(edge(map, "pong", "ping")).toBeDefined();
    expect(map.nodes.filter((n) => n.name === "ping")).toHaveLength(1);
  });

  it("marks a map bounded by depth as truncated", () => {
    const shallow = buildCodeMap({ depth: 1, file: FIXTURE, symbol: "Pipeline.run" });
    expect(shallow.truncated).toBe(true);

    const deep = buildCodeMap({ depth: 6, file: FIXTURE, symbol: "Pipeline.run" });
    expect(deep.truncated).toBe(false);
  });

  it("marks a map bounded by the node cap as truncated", () => {
    const map = buildCodeMap({
      depth: 5,
      file: FIXTURE,
      maxNodes: 2,
      symbol: "Pipeline.run",
    });

    expect(map.nodes).toHaveLength(2);
    expect(map.truncated).toBe(true);
  });

  it("finds Class.method from the bare method name when unambiguous", () => {
    expect(node(buildCodeMap({ file: FIXTURE, symbol: "run" }), "run")).toBeDefined();
  });

  it("names the declarations that exist when the symbol does not", () => {
    let thrown: unknown;
    try {
      buildCodeMap({ file: FIXTURE, symbol: "nosuchthing" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SymbolNotFoundError);
    expect((thrown as SymbolNotFoundError).message).toContain("normaliseAll");
  });

  it("explains itself when the file is outside the project", () => {
    expect(() =>
      buildCodeMap({ file: join(process.cwd(), "next.config.ts"), symbol: "x" }),
    ).toThrow();
  });

  it("names the root a relative path was resolved against", () => {
    // The failure seen in a real session: the workspace root holds several
    // repositories, and the caller passed a path missing the repository name.
    // "no tsconfig found" pointed at the wrong problem.
    const build = () =>
      buildCodeMap({
        cwd: "/Users/coen/Dev",
        file: "x-pack/platform/plugins/shared/significant_events/server/plugin.ts",
        symbol: "start",
      });

    expect(build).toThrow("does not exist");
    expect(build).toThrow("resolved relative to /Users/coen/Dev");
  });
});
