import { describe, expect, it } from "vitest";

import { resolveInsideRoot, toRelativePath } from "@/lib/pi/file-browser";

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
