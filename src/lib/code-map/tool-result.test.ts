/**
 * Nothing on the path from the extension to here is checked by the compiler —
 * jiti loads the extension from source and the map arrives as `unknown` on a
 * tool result. These tests stand in for the types that cannot.
 */
import { describe, expect, it } from "vitest";

import { readCodeMap, readCodeMapResult } from "./tool-result.ts";

const node = {
  container: null,
  external: false,
  file: "src/a.ts",
  id: "a",
  kind: "function",
  line: 1,
  name: "a",
};

const map = {
  depth: 2,
  edges: [{ from: "a", kind: "call", sites: [3], to: "a" }],
  nodes: [node],
  root: "a",
  truncated: false,
  unresolved: [],
};

describe("readCodeMap", () => {
  it("accepts a well-formed map", () => {
    expect(readCodeMap(map)?.root).toBe("a");
  });

  it("rejects a map whose nodes are not nodes", () => {
    expect(readCodeMap({ ...map, nodes: [{ id: "a" }] })).toBeNull();
  });

  it("rejects a map whose edges are not edges", () => {
    expect(readCodeMap({ ...map, edges: [{ from: "a" }] })).toBeNull();
  });

  it("rejects anything that is not an object", () => {
    expect(readCodeMap(null)).toBeNull();
    expect(readCodeMap("map")).toBeNull();
    expect(readCodeMap([])).toBeNull();
  });

  it("defaults the fields it can survive without", () => {
    const read = readCodeMap({ edges: [], nodes: [], root: "a" });

    expect(read).toMatchObject({ depth: 0, truncated: false, unresolved: [] });
  });
});

describe("readCodeMapResult", () => {
  it("reads the map out of a code_map tool result", () => {
    expect(
      readCodeMapResult({ details: { map, type: "code-map" } })?.root,
    ).toBe("a");
  });

  it("ignores a result from some other tool", () => {
    expect(readCodeMapResult({ details: { runId: "x", type: "workflow" } })).toBeNull();
  });

  it("ignores an errored result with no details", () => {
    expect(readCodeMapResult({ details: null, isError: true })).toBeNull();
  });

  it("does not throw on a shape it has never seen", () => {
    expect(readCodeMapResult(undefined)).toBeNull();
    expect(readCodeMapResult({ details: { map: 7, type: "code-map" } })).toBeNull();
  });
});
