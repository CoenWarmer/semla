/**
 * Load the skills available to this project, as bodies a model can read.
 *
 * Thin wrapper around pi-coding-agent's own `loadSkills` — discovery of skill
 * *locations* (global, project, package, settings, CLI) is already solved
 * there and duplicating it would drift from whatever pi decides "installed"
 * means. This module's only job is turning a `Skill` (name + `filePath`) into
 * a `SkillSource` (name + `filePath` + body), because `loadSkills` returns
 * metadata, not content — the caller reads `SKILL.md` itself.
 *
 * `loadSkills` alone is not the full picture, though. It only scans pi's own
 * default locations (`agentDir/skills`, `cwd/.pi/skills`) plus whatever
 * `skillPaths` are handed to it — it has no notion of the separate
 * `~/.agents/skills` (personal, cross-project) and ancestor `.agents/skills`
 * (project, walked up to the git root) directories that a live session sees.
 * That discovery exists only inside pi's `DefaultPackageManager`
 * (`collectAncestorAgentsSkillDirs` / `userAgentsSkillsDir` in
 * package-manager.js), which `DefaultResourceLoader` goes through and this
 * module's caller, `loadSkills`, does not. A skill installed only under
 * `~/.agents/skills` — e.g. `next-dev-loop` — was consequently visible to a
 * live session but invisible to verification-signal discovery, which is a
 * different code path built directly on `loadSkills`.
 *
 * `agentsSkillDirs` below replicates that ancestor walk so both paths agree
 * on what "installed" means, and its result is passed as extra `skillPaths`
 * — `loadSkills` treats each as a plain directory to scan, same as any
 * explicit path.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { loadSkills } from "@earendil-works/pi-coding-agent";

import { PI_AGENT_DIR } from "@/lib/pi/runtime/agent-dir";
import { WORKFLOW_SKILLS_PATH } from "@/lib/pi/runtime/runtime-config";

import type { SkillSource } from "./skill-signals";

export interface LoadSkillSourcesResult {
  sources: SkillSource[];
  warnings: string[];
}

/**
 * Directory pi's own package manager checks for a repo root while walking
 * upward — `collectAncestorAgentsSkillDirs` in package-manager.js stops at
 * the first ancestor containing `.git`. Duplicated here rather than imported
 * because pi does not export that walk; only its *effect* (resource
 * collection inside `DefaultResourceLoader`) is public.
 */
function findGitRepoRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * `~/.agents/skills` plus every ancestor `.agents/skills` from `cwd` up to
 * the git repo root (or filesystem root if none) — the same set
 * `collectAncestorAgentsSkillDirs` builds for a live session. Only existing
 * directories are returned; `loadSkills` already warns on a path that does
 * not exist, and there is no reason to manufacture that warning for every
 * ancestor a repo happens not to have.
 */
function agentsSkillDirs(cwd: string): string[] {
  const dirs: string[] = [];
  const userAgentsSkillsDir = join(homedir(), ".agents", "skills");
  if (existsSync(userAgentsSkillsDir)) dirs.push(userAgentsSkillsDir);

  const gitRepoRoot = findGitRepoRoot(cwd);
  let dir = resolve(cwd);
  while (true) {
    const candidate = join(dir, ".agents", "skills");
    if (resolve(candidate) !== resolve(userAgentsSkillsDir) && existsSync(candidate)) {
      dirs.push(candidate);
    }
    if (gitRepoRoot && dir === gitRepoRoot) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return dirs;
}

/**
 * Same locations a live session sees: global skills under Semla's isolated
 * agent dir, project skills under `cwd`, the workflow package's own skills,
 * and the `~/.agents/skills` / ancestor `.agents/skills` directories pi's
 * `DefaultResourceLoader` collects but its standalone `loadSkills` does not
 * — mirroring the `additionalSkillPaths` session-service.ts passes to
 * `DefaultResourceLoader`. A skill this call cannot see is one no session
 * would have loaded either, which is the invariant that matters here.
 */
export async function loadSkillSources(options: { cwd: string }): Promise<LoadSkillSourcesResult> {
  const { skills, diagnostics } = loadSkills({
    agentDir: PI_AGENT_DIR,
    cwd: options.cwd,
    includeDefaults: true,
    skillPaths: [WORKFLOW_SKILLS_PATH, ...agentsSkillDirs(options.cwd)],
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
