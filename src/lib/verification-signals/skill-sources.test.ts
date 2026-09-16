/**
 * `loadSkillSources` against real temp directories rather than mocking
 * `loadSkills` itself — the thing under test is that `~/.agents/skills` and
 * ancestor `.agents/skills` directories are actually passed to it as
 * `skillPaths`, which only shows up if a skill placed there is found in the
 * result.
 *
 * `node:os`'s `homedir` is mocked because `agentsSkillDirs` reads it directly
 * to build the "personal, cross-project" location — the one gap this module
 * exists to close (see skill-sources.ts's docblock). Nothing else is mocked;
 * `loadSkills` itself runs for real against the temp tree.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `agent-dir.ts` (a transitive import of `skill-sources.ts`) reads `homedir()`
// once at module-load time to compute a top-level constant. That import
// happens below, before `beforeEach` has run, so `fakeHome` needs a real
// value from the start rather than being assigned lazily — `agentsSkillDirs`
// itself calls `homedir()` per-invocation, so reassigning in `beforeEach`
// still takes effect for the behaviour under test.
let fakeHome: string = mkdtempSync(join(tmpdir(), "skill-sources-home-initial-"));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => fakeHome };
});

const { loadSkillSources } = await import("./skill-sources");

let projectRoot: string;

function writeSkill(dir: string, name: string, description = "does a thing"): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`,
    "utf8",
  );
}

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "skill-sources-home-"));
  projectRoot = mkdtempSync(join(tmpdir(), "skill-sources-project-"));
  // loadSkills's ancestor walk stops at the first ancestor with `.git`;
  // give the temp project one so it does not walk out into the real
  // filesystem above `tmpdir()`.
  mkdirSync(join(projectRoot, ".git"), { recursive: true });
});

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

describe("loadSkillSources", () => {
  it("finds a skill installed only under ~/.agents/skills", async () => {
    writeSkill(join(fakeHome, ".agents", "skills", "next-dev-loop"), "next-dev-loop");

    const { sources, warnings } = await loadSkillSources({ cwd: projectRoot });

    expect(warnings).toEqual([]);
    expect(sources.map((s) => s.name)).toContain("next-dev-loop");
  });

  it("finds a skill installed under the project's own .agents/skills", async () => {
    writeSkill(join(projectRoot, ".agents", "skills", "project-only"), "project-only");

    const { sources } = await loadSkillSources({ cwd: projectRoot });

    expect(sources.map((s) => s.name)).toContain("project-only");
  });

  it("does not warn or fabricate an .agents skill when neither directory exists", async () => {
    const { sources, warnings } = await loadSkillSources({ cwd: projectRoot });

    // `includeDefaults: true` still pulls in real, unrelated skills (this
    // repo's own workflow skills, whatever is under the real PI_AGENT_DIR) —
    // the assertion here is only that discovery does not warn about a missing
    // .agents/skills directory, and does not invent an entry for one.
    expect(warnings).toEqual([]);
    expect(sources.map((s) => s.name)).not.toContain("next-dev-loop");
    expect(sources.map((s) => s.name)).not.toContain("project-only");
  });
});
