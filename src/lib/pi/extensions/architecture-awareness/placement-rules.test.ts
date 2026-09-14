import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertPlacementFileWithinBudget,
  checkPlacement,
  estimateTokens,
  loadPlacementFile,
  parsePlacementRules,
  PlacementFileTooLargeError,
  placementFilePath,
} from "./placement-rules";

describe("parsePlacementRules", () => {
  it("parses directive lines containing an arrow", () => {
    const contents = [
      "# Placement",
      "",
      "new REST route -> server/routes/",
      "- shared utility -> src/lib/",
      "prose with no arrow is ignored",
      "",
    ].join("\n");

    const rules = parsePlacementRules(contents);

    expect(rules).toEqual([
      { destination: "server/routes/", raw: "new REST route -> server/routes/", situation: "new REST route" },
      { destination: "src/lib/", raw: "- shared utility -> src/lib/", situation: "shared utility" },
    ]);
  });

  it("returns no rules for a file with no directive lines", () => {
    expect(parsePlacementRules("# Just prose\n\nNo rules here.")).toEqual([]);
  });

  it("ignores a line with an arrow but an empty side", () => {
    expect(parsePlacementRules("-> server/routes/")).toEqual([]);
    expect(parsePlacementRules("new REST route ->")).toEqual([]);
  });
});

describe("checkPlacement", () => {
  const rules = parsePlacementRules("new REST route -> server/routes/\nshared utility -> src/lib/");

  it("allows a target_module matching a rule's destination", () => {
    expect(checkPlacement("server/routes/users.ts", rules).allowed).toBe(true);
  });

  it("allows any target_module when there are no rules", () => {
    expect(checkPlacement("anywhere/at/all", []).allowed).toBe(true);
  });

  it("allows an empty target_module (nothing to contradict)", () => {
    expect(checkPlacement("", rules).allowed).toBe(true);
  });

  it("rejects a target_module that matches no rule's destination", () => {
    // Note: per the module docblock, absence of a match against *any* rule
    // means rejected only when rules exist and none apply — the check is
    // deliberately permissive, not an exhaustive allowlist.
    const result = checkPlacement("completely/unrelated/path", rules);
    expect(result.allowed).toBe(false);
  });
});

describe("estimateTokens / assertPlacementFileWithinBudget", () => {
  it("estimates roughly four characters per token", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });

  it("throws PlacementFileTooLargeError over the cap", () => {
    const file = { contents: "a".repeat(40_000), path: "/tmp/PLACEMENT.md", rules: [] };
    expect(() => assertPlacementFileWithinBudget(file, 100)).toThrow(PlacementFileTooLargeError);
  });

  it("does not throw within the cap", () => {
    const file = { contents: "short", path: "/tmp/PLACEMENT.md", rules: [] };
    expect(() => assertPlacementFileWithinBudget(file, 100)).not.toThrow();
  });
});

describe("loadPlacementFile", () => {
  let dir: string;

  afterEach(() => {
    if (dir && existsSync(dir)) rmSync(dir, { force: true, recursive: true });
  });

  it("returns null when PLACEMENT.md is absent — never synthesises a substitute", () => {
    dir = mkdtempSync(join(tmpdir(), "placement-test-"));
    expect(loadPlacementFile(dir)).toBeNull();
  });

  it("reads and parses an existing PLACEMENT.md", () => {
    dir = mkdtempSync(join(tmpdir(), "placement-test-"));
    writeFileSync(placementFilePath(dir), "new REST route -> server/routes/\n");

    const file = loadPlacementFile(dir);

    expect(file?.rules).toEqual([
      { destination: "server/routes/", raw: "new REST route -> server/routes/", situation: "new REST route" },
    ]);
  });
});
