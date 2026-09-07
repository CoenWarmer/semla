import { describe, expect, it } from "vitest";

import { parseFilePathToken, resolveFileToken } from "./file-path-token";

describe("parseFilePathToken", () => {
  it("parses a plain project-relative path", () => {
    expect(parseFilePathToken("src/foo.ts")).toEqual({
      line: null,
      rawPath: "src/foo.ts",
    });
  });

  it("parses a trailing line number", () => {
    expect(parseFilePathToken("src/foo.ts:42")).toEqual({
      line: 42,
      rawPath: "src/foo.ts",
    });
  });

  it("parses a trailing line and column, dropping the column", () => {
    expect(parseFilePathToken("src/foo.ts:42:7")).toEqual({
      line: 42,
      rawPath: "src/foo.ts",
    });
  });

  it("rejects a bare word with no extension", () => {
    expect(parseFilePathToken("foo")).toBeNull();
  });

  it("rejects a directory with no file", () => {
    expect(parseFilePathToken("src/lib/")).toBeNull();
  });

  it("rejects a URL", () => {
    expect(parseFilePathToken("https://example.com/foo.ts")).toBeNull();
  });

  it("rejects an absolute path", () => {
    expect(parseFilePathToken("/etc/passwd.ts")).toBeNull();
  });

  it("rejects a path that climbs out with ..", () => {
    expect(parseFilePathToken("../../etc/foo.ts")).toBeNull();
  });

  it("rejects a version string", () => {
    expect(parseFilePathToken("1.2.3")).toBeNull();
  });

  it("rejects an extensionless dotted word", () => {
    expect(parseFilePathToken("v2.production")).toBeNull();
  });

  it("rejects text with whitespace", () => {
    expect(parseFilePathToken("src/foo bar.ts")).toBeNull();
  });

  it("rejects an empty or whitespace-only token", () => {
    expect(parseFilePathToken("   ")).toBeNull();
  });

  it("treats a zero or negative trailing number as no line", () => {
    expect(parseFilePathToken("src/foo.ts:0")).toEqual({
      line: null,
      rawPath: "src/foo.ts",
    });
  });
});

describe("resolveFileToken", () => {
  const token = { line: 42, rawPath: "src/foo.ts" };

  it("returns null when the session has no attached projects", () => {
    expect(resolveFileToken(token, [])).toBeNull();
  });

  it("resolves against the sole attached project", () => {
    expect(resolveFileToken(token, ["semla"])).toEqual({
      line: 42,
      path: "src/foo.ts",
      project: "semla",
    });
  });

  it("refuses to guess among multiple attached projects for a bare path", () => {
    expect(resolveFileToken(token, ["semla", "catalog-info"])).toBeNull();
  });

  it("resolves an explicitly project-qualified path among several projects", () => {
    const qualified = { line: 42, rawPath: "catalog-info/src/foo.ts" };
    expect(resolveFileToken(qualified, ["semla", "catalog-info"])).toEqual({
      line: 42,
      path: "src/foo.ts",
      project: "catalog-info",
    });
  });

  it("does not treat a project-qualifying-looking first segment as a match when it isn't attached", () => {
    const qualified = { line: 42, rawPath: "other-repo/src/foo.ts" };
    expect(resolveFileToken(qualified, ["semla", "catalog-info"])).toBeNull();
  });
});
