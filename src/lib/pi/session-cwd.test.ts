/**
 * Pointing a session at the workspace root made every prompt pay to index the
 * parent of every repository: `bindExtensions` took 70 s on a process's first
 * prompt and ~32 s on each one after, for "Hi how's it going?" as much as for a
 * refactor. Anchoring the session to its own project is the difference, so the
 * rules for picking it — and for refusing a bad one — are worth pinning down.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";

import { isProjectAnchored, resolveSessionCwd } from "./session-cwd.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "semla-cwd-"));
  await mkdir(join(root, "semla"), { recursive: true });
  await mkdir(join(root, "kibana"), { recursive: true });
  await writeFile(join(root, "notes.md"), "not a directory", "utf8");
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

describe("resolveSessionCwd", () => {
  it("runs the agent in the session's anchor project", () => {
    expect(resolveSessionCwd(["semla"], root)).toBe(join(root, "semla"));
  });

  // Anchor first is the contract; the rest are reachable by absolute path.
  it("uses the anchor, not any later project", () => {
    expect(resolveSessionCwd(["semla", "kibana"], root)).toBe(
      join(root, "semla"),
    );
  });

  /**
   * A brand new session has no project until its first write. It must still
   * start — slow is recoverable, refusing the turn is not.
   */
  it("falls back to the workspace root when there is no anchor", () => {
    expect(resolveSessionCwd([], root)).toBe(root);
  });

  it("falls back for an anchor that is only whitespace", () => {
    expect(resolveSessionCwd(["   "], root)).toBe(root);
  });

  // The project was renamed or moved since the link was written.
  it("falls back when the anchor no longer exists", () => {
    expect(resolveSessionCwd(["gone"], root)).toBe(root);
  });

  it("falls back when the anchor is a file", () => {
    expect(resolveSessionCwd(["notes.md"], root)).toBe(root);
  });

  /**
   * The anchor comes from the database, so it is untrusted: a path that climbs
   * out of the root would move the agent — and its bash executor — somewhere
   * the rest of the app cannot address.
   */
  it.each(["../..", "../elsewhere", "/etc"])(
    "refuses an anchor that escapes the workspace: %s",
    (anchor) => {
      expect(resolveSessionCwd([anchor], root)).toBe(root);
    },
  );

  it("refuses the workspace root itself as an anchor", () => {
    expect(resolveSessionCwd(["."], root)).toBe(root);
  });

  // A nested checkout is addressable and real, so it is allowed to be the cwd.
  it("accepts a nested directory inside a project", async () => {
    await mkdir(join(root, "semla", "packages", "app"), { recursive: true });

    expect(resolveSessionCwd(["semla/packages/app"], root)).toBe(
      join(root, "semla", "packages", "app"),
    );
  });
});

/**
 * Gates the project-scoped extensions. Derived from the resolved cwd rather
 * than the project list, so every reason an anchor was refused — missing,
 * escaping the root, or naming a directory that is gone — lands on the same
 * answer as having no project at all.
 */
describe("isProjectAnchored", () => {
  it("is true for a session running inside a project", () => {
    expect(isProjectAnchored(resolveSessionCwd(["semla"], root), root)).toBe(true);
  });

  it("is false for a session with no project", () => {
    expect(isProjectAnchored(resolveSessionCwd([], root), root)).toBe(false);
  });

  it.each([["gone"], ["notes.md"], ["../elsewhere"]])(
    "is false for an anchor that was refused: %s",
    (anchor) => {
      expect(isProjectAnchored(resolveSessionCwd([anchor], root), root)).toBe(
        false,
      );
    },
  );
});
