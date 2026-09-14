import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  getProjectArchitectureAwarenessSettingsPath,
  loadArchitectureAwarenessSettings,
  saveArchitectureAwarenessSettings,
} from "./settings";

describe("loadArchitectureAwarenessSettings", () => {
  it("defaults every item to enabled — nothing here opts an item out by default", () => {
    const settings = loadArchitectureAwarenessSettings();
    expect(settings.placementPromptEnabled).toBe(true);
    expect(settings.specPersistenceEnabled).toBe(true);
    expect(settings.placementToolsEnabled).toBe(true);
    expect(settings.enforcementEnabled).toBe(true);
    expect(settings.enforcementCommand).toBeUndefined();
  });
});

describe("saveArchitectureAwarenessSettings + project override", () => {
  let dir: string;

  afterEach(() => {
    if (dir && existsSync(dir)) rmSync(dir, { force: true, recursive: true });
  });

  it("lets a project-level file disable one item independently of the others — the A/B constraint", () => {
    dir = mkdtempSync(join(tmpdir(), "aa-settings-test-"));
    const projectPath = getProjectArchitectureAwarenessSettingsPath(dir);

    saveArchitectureAwarenessSettings(
      { enforcementCommand: "npx depcruise", placementToolsEnabled: false },
      projectPath,
    );

    const settings = loadArchitectureAwarenessSettings(dir);
    expect(settings.placementToolsEnabled).toBe(false);
    expect(settings.enforcementCommand).toBe("npx depcruise");
    // Untouched items keep their defaults.
    expect(settings.placementPromptEnabled).toBe(true);
    expect(settings.specPersistenceEnabled).toBe(true);
  });
});
