import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { placementFilePath } from "./placement-rules";
import {
  assertPlacementFileWithinSessionBudget,
  PLACEMENT_PROMPT_HEADER,
  readPlacementFileForCwd,
} from "./placement-prompt";

describe("readPlacementFileForCwd", () => {
  let dir: string;

  afterEach(() => {
    if (dir && existsSync(dir)) rmSync(dir, { force: true, recursive: true });
  });

  it("returns null and injects nothing when PLACEMENT.md is absent", () => {
    dir = mkdtempSync(join(tmpdir(), "placement-prompt-test-"));
    expect(readPlacementFileForCwd(dir)).toBeNull();
  });

  it("returns the file's contents verbatim when present", () => {
    dir = mkdtempSync(join(tmpdir(), "placement-prompt-test-"));
    writeFileSync(placementFilePath(dir), "new REST route -> server/routes/\n");

    const file = readPlacementFileForCwd(dir);
    expect(file?.contents).toBe("new REST route -> server/routes/\n");
  });
});

describe("assertPlacementFileWithinSessionBudget", () => {
  let dir: string;

  afterEach(() => {
    if (dir && existsSync(dir)) rmSync(dir, { force: true, recursive: true });
  });

  it("does nothing when there is no PLACEMENT.md", () => {
    dir = mkdtempSync(join(tmpdir(), "placement-prompt-test-"));
    expect(assertPlacementFileWithinSessionBudget(dir, 100)).toBeNull();
  });

  it("fails loudly — throws, does not truncate — when the file exceeds the token cap", () => {
    dir = mkdtempSync(join(tmpdir(), "placement-prompt-test-"));
    writeFileSync(placementFilePath(dir), "x".repeat(10_000));

    expect(() => assertPlacementFileWithinSessionBudget(dir, 100)).toThrow(/token cap/);
  });

  it("passes and returns the file when within budget", () => {
    dir = mkdtempSync(join(tmpdir(), "placement-prompt-test-"));
    writeFileSync(placementFilePath(dir), "new REST route -> server/routes/\n");

    const file = assertPlacementFileWithinSessionBudget(dir, 1000);
    expect(file?.rules).toHaveLength(1);
  });
});

describe("PLACEMENT_PROMPT_HEADER", () => {
  it("is present so an injected block is identifiable in the assembled prompt", () => {
    expect(PLACEMENT_PROMPT_HEADER).toContain("PLACEMENT.md");
  });
});
