/**
 * pi-llm-wiki asks "is there a vault at the current directory?" before it looks
 * at WIKI_HOME, so one `.llm-wiki` in a repo the agent works in quietly takes
 * over from .semla-wiki. It happened: a stray vault appeared in the repo root
 * and three captures went into it instead.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  describeShadowingVaults,
  findShadowingVaults,
} from "./wiki-vault-location.ts";

const workspace = () => mkdtempSync(join(tmpdir(), "semla-ws-"));

const repo = (root: string, name: string, withVault = false) => {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  if (withVault) {
    mkdirSync(join(dir, ".llm-wiki", "meta"), { recursive: true });
    writeFileSync(join(dir, ".llm-wiki", "config.json"), "{}", "utf8");
  }
  return dir;
};

describe("findShadowingVaults", () => {
  it("finds a vault in a repo the agent works in", () => {
    const ws = workspace();
    const stray = repo(ws, "some-project", true);
    repo(ws, "innocent-project");

    expect(findShadowingVaults(ws, join(ws, ".semla-wiki"))).toEqual([stray]);
  });

  it("finds one at the workspace root itself", () => {
    const ws = workspace();
    mkdirSync(join(ws, ".llm-wiki"), { recursive: true });

    expect(findShadowingVaults(ws, join(ws, ".semla-wiki"))).toContain(ws);
  });

  // The vault being protected is not a problem with itself.
  it("does not report Semla's own vault", () => {
    const ws = workspace();
    const home = join(ws, ".semla-wiki");
    mkdirSync(join(home, ".llm-wiki"), { recursive: true });

    expect(findShadowingVaults(ws, home)).toEqual([]);
  });

  it("finds the legacy layout too", () => {
    const ws = workspace();
    const dir = join(ws, "old-project");
    mkdirSync(join(dir, ".wiki"), { recursive: true });

    expect(findShadowingVaults(ws, join(ws, ".semla-wiki"))).toEqual([dir]);
  });

  it("is quiet when there is nothing to report", () => {
    const ws = workspace();
    repo(ws, "a");
    repo(ws, "b");

    expect(findShadowingVaults(ws, join(ws, ".semla-wiki"))).toEqual([]);
  });

  it("does not fail on a workspace that does not exist", () => {
    expect(findShadowingVaults("/nonexistent-workspace", "/nowhere")).toEqual([]);
  });
});

describe("describeShadowingVaults", () => {
  it("says what will happen, not just what was found", () => {
    const message = describeShadowingVaults(["/Dev/thing"], "/Dev/semla/.semla-wiki");

    expect(message).toContain("/Dev/thing/.llm-wiki");
    expect(message).toContain("/Dev/semla/.semla-wiki");
    expect(message).toContain("orient will write there instead");
  });
});
