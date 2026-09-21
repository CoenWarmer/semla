/**
 * `labelSkillSource` is the only new logic here beyond what
 * `skill-sources.test.ts` already covers for discovery itself (that test
 * exercises `discoverSkills`'s predecessor, `loadSkillSources`, against real
 * temp directories). This file only needs to prove the classifier picks the
 * right label for each directory `discoverSkills` actually scans, so it
 * builds paths directly rather than re-running discovery.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PI_AGENT_DIR } from "@/lib/pi/runtime/agent-dir";
import { WORKFLOW_SKILLS_PATH } from "@/lib/pi/runtime/runtime-config";

import { labelSkillSource } from "./discover-skills";

describe("labelSkillSource", () => {
  it("labels a skill under the workflow package", () => {
    const filePath = join(WORKFLOW_SKILLS_PATH, "orient", "SKILL.md");
    expect(labelSkillSource(filePath, "/some/project")).toBe("Workflow package");
  });

  it("labels a skill under Semla's global agent dir", () => {
    const filePath = join(PI_AGENT_DIR, "skills", "some-skill", "SKILL.md");
    expect(labelSkillSource(filePath, "/some/project")).toBe("Global (Semla agent dir)");
  });

  it("labels a skill under the project's .pi/skills", () => {
    const cwd = "/some/project";
    const filePath = join(cwd, ".pi", "skills", "some-skill", "SKILL.md");
    expect(labelSkillSource(filePath, cwd)).toBe("Project (.pi/skills)");
  });

  it("labels a skill under an ancestor .agents/skills as project-scoped", () => {
    const cwd = "/some/project";
    const filePath = join(cwd, ".agents", "skills", "some-skill", "SKILL.md");
    expect(labelSkillSource(filePath, cwd)).toBe("Project (.agents/skills)");
  });

  it("labels a skill under ~/.agents/skills as personal", () => {
    const filePath = join(homedir(), ".agents", "skills", "some-skill", "SKILL.md");
    expect(labelSkillSource(filePath, "/some/project")).toBe("Personal (~/.agents/skills)");
  });
});
