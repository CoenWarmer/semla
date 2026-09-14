import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  listDirectory,
  resolveInsideRoot,
  toRelativePath,
} from "@/lib/pi/file-browser";

const ROOT = "/Users/x/Dev";

describe("resolveInsideRoot", () => {
  it("resolves a relative path against the root", () => {
    expect(resolveInsideRoot(ROOT, "semla/src")).toBe("/Users/x/Dev/semla/src");
  });

  it("resolves an empty path to the root itself", () => {
    expect(resolveInsideRoot(ROOT, "")).toBe(ROOT);
  });

  it("refuses a path that climbs out of the root", () => {
    expect(resolveInsideRoot(ROOT, "../secrets")).toBeNull();
    expect(resolveInsideRoot(ROOT, "semla/../../secrets")).toBeNull();
  });

  it("refuses an absolute path", () => {
    expect(resolveInsideRoot(ROOT, "/etc/passwd")).toBeNull();
  });

  it("allows a climb that stays inside the root", () => {
    expect(resolveInsideRoot(ROOT, "semla/src/..")).toBe("/Users/x/Dev/semla");
  });
});

describe("toRelativePath", () => {
  it("expresses an absolute path relative to the root", () => {
    expect(toRelativePath(ROOT, "/Users/x/Dev/semla/src/page.tsx")).toBe(
      "semla/src/page.tsx",
    );
  });
});

describe("listDirectory", () => {
  let dir: string;

  afterEach(() => {
    rmSync(dir, { force: true, recursive: true });
  });

  it("leaves dotted names out by default", async () => {
    dir = mkdtempSync(join(tmpdir(), "semla-files-"));
    writeFileSync(join(dir, "visible.ts"), "");
    writeFileSync(join(dir, ".env"), "");

    const files = await listDirectory(dir, "");
    expect(files.map((entry) => entry.name)).toEqual(["visible.ts"]);
  });

  it("includes dotted names when told to", async () => {
    dir = mkdtempSync(join(tmpdir(), "semla-files-"));
    writeFileSync(join(dir, "visible.ts"), "");
    writeFileSync(join(dir, ".env"), "");

    const files = await listDirectory(dir, "", true);
    expect(files.map((entry) => entry.name)).toEqual([".env", "visible.ts"]);
  });
});
