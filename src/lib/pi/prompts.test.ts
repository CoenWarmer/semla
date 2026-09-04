/**
 * What the agent is told about the session's projects.
 *
 * This block used to name one project, interpolated from an absolute path. A
 * session can work in several, and the agent decides each wiki page's `repo:`
 * tag from what it reads here — so a prompt that claims one project while the
 * session works in three is how pages come to inherit the wrong slug.
 */
import { describe, expect, it } from "vitest";

import { buildMemoryContextBlock } from "@/lib/pi/prompts";

describe("buildMemoryContextBlock", () => {
  it("names the anchor as the active project", () => {
    const block = buildMemoryContextBlock(["semla"]);

    expect(block).toContain("The active project for this session is `semla`.");
    expect(block).toContain("use `repo: semla` in frontmatter");
  });

  it("names the project by slug, not by absolute path", () => {
    // The prompt used to interpolate the session's absolute path, which is how
    // pages in the vault came to carry `/Users/me/Dev/thing` as their repo.
    // Only the project lines are checked: the vault's own location is a real
    // path and belongs in the block.
    const projectLines = buildMemoryContextBlock(["semla"])
      .split("\n")
      .filter((line) => line.includes("active project") || line.includes("repo:"));

    expect(projectLines.length).toBeGreaterThan(0);
    for (const line of projectLines) expect(line).not.toMatch(/[`\s]\/\w/);
  });

  it("names the other projects a session works in", () => {
    const block = buildMemoryContextBlock(["semla", "kibana", "ecs"]);

    expect(block).toContain("The active project for this session is `semla`.");
    expect(block).toContain("also works in `kibana`, `ecs`");
  });

  it("says nothing about other projects when there is only one", () => {
    expect(buildMemoryContextBlock(["semla"])).not.toContain("also works in");
  });

  it("omits the project section entirely for a session with none", () => {
    const block = buildMemoryContextBlock([]);

    expect(block).not.toContain("The active project");
    expect(block).not.toContain("also works in");
    // The wiki guidance itself is not conditional on having a project.
    expect(block).toContain("# Codebase wiki");
  });
});

describe("buildMemoryContextBlock — concurrency (phase 1 of session-isolation.md)", () => {
  it("says nothing about other sessions when none are active", () => {
    const block = buildMemoryContextBlock(["semla"], {});

    expect(block).not.toContain("Other sessions working here");
  });

  it("says nothing when the map has an empty entry for the project", () => {
    const block = buildMemoryContextBlock(["semla"], { semla: [] });

    expect(block).not.toContain("Other sessions working here");
  });

  it("names the project and count when another session is active on it", () => {
    const block = buildMemoryContextBlock(["semla"], { semla: ["other-1"] });

    expect(block).toContain("Other sessions working here right now");
    expect(block).toContain("`semla`: 1 other session active right now.");
    expect(block).toContain("no isolation between concurrent sessions");
  });

  it("pluralises and reports only the projects that are actually contended", () => {
    const block = buildMemoryContextBlock(["semla", "kibana"], {
      semla: ["a", "b"],
      kibana: [],
    });

    expect(block).toContain("`semla`: 2 other sessions active right now.");
    expect(block).not.toContain("`kibana`:");
  });
});
