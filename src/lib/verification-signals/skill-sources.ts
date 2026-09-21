/**
 * Load the skills available to this project, as bodies a model can read.
 *
 * Discovery of skill *locations* (global, project, package, `~/.agents`,
 * ancestor `.agents/skills`) lives in `discoverSkills` — shared with the
 * skills-in-the-UI catalog, which needs the same locations but never reads a
 * body. This module's only job is turning a `Skill` (name + `filePath`) into
 * a `SkillSource` (name + `filePath` + body), because `loadSkills` returns
 * metadata, not content — the caller reads `SKILL.md` itself.
 */

import { readFile } from "node:fs/promises";

import { discoverSkills } from "@/lib/pi/skills/discover-skills";

import type { SkillSource } from "./skill-signals";

export interface LoadSkillSourcesResult {
  sources: SkillSource[];
  warnings: string[];
}

export async function loadSkillSources(options: { cwd: string }): Promise<LoadSkillSourcesResult> {
  const { skills, warnings: discoveryWarnings } = discoverSkills(options);
  const warnings = [...discoveryWarnings];

  const sources: SkillSource[] = [];
  for (const skill of skills) {
    try {
      const content = await readFile(skill.filePath, "utf8");
      sources.push({ content, filePath: skill.filePath, name: skill.name });
    } catch (error) {
      warnings.push(
        `Could not read skill "${skill.name}" at ${skill.filePath}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { sources, warnings };
}
