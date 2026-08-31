/**
 * The monorepo case is the one worth pinning.
 *
 * Kibana ships a tsconfig.json inside every plugin, so the nearest one to a file
 * is a package rather than the repository. Resolving display paths against it
 * alone produced `server/plugin.ts` for a file the caller had addressed as
 * `kibana/x-pack/platform/plugins/shared/significant_events/server/plugin.ts` —
 * ambiguous across a hundred plugins, and not the path anything else in the
 * session uses.
 */
import { describe, expect, it } from "vitest";

import { displayPath } from "./declarations.ts";

const WORKSPACE = "/Users/coen/Dev";
const PLUGIN =
  "/Users/coen/Dev/kibana/x-pack/platform/plugins/shared/significant_events";
const FILE = `${PLUGIN}/server/plugin.ts`;

describe("displayPath", () => {
  it("prefers the workspace over a nested package tsconfig", () => {
    expect(displayPath(FILE, [WORKSPACE, PLUGIN])).toBe(
      "kibana/x-pack/platform/plugins/shared/significant_events/server/plugin.ts",
    );
  });

  it("falls back to the next root when the file is outside the first", () => {
    expect(displayPath(FILE, ["/somewhere/else", PLUGIN])).toBe(
      "server/plugin.ts",
    );
  });

  it("returns the absolute path rather than a pile of ../", () => {
    expect(displayPath(FILE, ["/somewhere/else"])).toBe(FILE);
  });

  it("ignores an empty root", () => {
    expect(displayPath(FILE, ["", WORKSPACE])).toBe(
      "kibana/x-pack/platform/plugins/shared/significant_events/server/plugin.ts",
    );
  });

  it("does not return an empty string for the root directory itself", () => {
    // relative(root, root) is "", which would render as a node with no file.
    expect(displayPath(WORKSPACE, [WORKSPACE, PLUGIN])).toBe(WORKSPACE);
  });
});
