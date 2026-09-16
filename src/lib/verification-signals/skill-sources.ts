/**
 * Load the skills available to this project, as bodies a model can read.
 *
 * Thin wrapper around pi-coding-agent's own `loadSkills` — discovery of skill
 * *locations* (global, project, package, settings, CLI) is already solved
 * there and duplicating it would drift from whatever pi decides "installed"
 * means. This module's only job is turning a `Skill` (name + `filePath`) into
 * a `SkillSource` (name + `filePath` + body), because `loadSkills` returns
 * metadata, not content — the caller reads `SKILL.md` itself.
 */

import { readFile } from "node:fs/promises";

import { loadSkills } from "@earendil-works/pi-coding-agent";

import { PI_AGENT_DIR } from "@/lib/pi/runtime/agent-dir";
import { WORKFLOW_SKILLS_PATH } from "@/lib/pi/runtime/runtime-config";

import type { SkillSource } from "./skill-signals";

export interface LoadSkillSourcesResult {
  sources: SkillSource[];
  warnings: string[];
}

/**
 * Same locations a live session sees: global skills under Semla's isolated
 * agent dir, project skills under `cwd`, plus the workflow package's own
 * skills — mirroring the `additionalSkillPaths` session-service.ts passes to
 * `DefaultResourceLoader`. A skill this call cannot see is one no session
 * would have loaded either, which is the invariant that matters here.
 */
export async function loadSkillSources(options: { cwd: string }): Promise<LoadSkillSourcesResult> {
  const { skills, diagnostics } = loadSkills({
    agentDir: PI_AGENT_DIR,
    cwd: options.cwd,
    includeDefaults: true,
    skillPaths: [WORKFLOW_SKILLS_PATH],
  });

  const warnings = diagnostics.map(
    (diagnostic) => `Skill discovery: ${diagnostic.message} (${diagnostic.path})`,
  );

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
