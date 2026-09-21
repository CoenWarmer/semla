/**
 * Discover the skills available to a Semla session, from every location a
 * live session actually loads them from.
 *
 * Extracted out of `verification-signals/skill-sources.ts`, which needed this
 * exact discovery (global, project, workflow-package, and the `~/.agents` /
 * ancestor `.agents/skills` directories `loadSkills` alone does not know
 * about) before it read each skill's body. The skills-in-the-UI feature needs
 * the same discovery but never reads a body — it only lists name,
 * description, and where a skill came from — so the discovery step is shared
 * and each caller does its own, different, thing with the result.
 *
 * See that module's original docblock for why `loadSkills` alone is not the
 * full picture: it has no notion of `~/.agents/skills` or ancestor
 * `.agents/skills`, which only pi's `DefaultPackageManager` walks for a live
 * session.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

import { loadSkills, type Skill } from "@earendil-works/pi-coding-agent";

import { PI_AGENT_DIR } from "@/lib/pi/runtime/agent-dir";
import { WORKFLOW_SKILLS_PATH } from "@/lib/pi/runtime/runtime-config";

export interface DiscoverSkillsResult {
  skills: Skill[];
  warnings: string[];
}

/**
 * Human-readable label for where a skill came from.
 *
 * `Skill.sourceInfo.scope`/`.source` do not distinguish what the UI needs to
 * show: `loadSkills` is called here with `includeDefaults: true`, which makes
 * every explicit `skillPaths` entry (the workflow package, `~/.agents/skills`,
 * ancestor `.agents/skills`) report the same generic `"local"`/`"temporary"`
 * source regardless of which of those three it actually is. Classifying by
 * which directory a skill's `filePath` falls under is the only way to tell
 * them apart, so it is done here once rather than in every caller that wants
 * to show it.
 */
export type SkillSourceLabel =
  | "Global (Semla agent dir)"
  | "Project (.pi/skills)"
  | "Workflow package"
  | "Personal (~/.agents/skills)"
  | "Project (.agents/skills)";

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
export function agentsSkillDirs(cwd: string): string[] {
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
export function discoverSkills(options: { cwd: string }): DiscoverSkillsResult {
  const { skills, diagnostics } = loadSkills({
    agentDir: PI_AGENT_DIR,
    cwd: options.cwd,
    includeDefaults: true,
    skillPaths: [WORKFLOW_SKILLS_PATH, ...agentsSkillDirs(options.cwd)],
  });

  const warnings = diagnostics.map(
    (diagnostic) => `Skill discovery: ${diagnostic.message} (${diagnostic.path})`,
  );

  return { skills, warnings };
}

function isUnder(filePath: string, dir: string): boolean {
  const resolvedDir = resolve(dir);
  const prefix = resolvedDir.endsWith("/") ? resolvedDir : `${resolvedDir}/`;
  return resolve(filePath).startsWith(prefix);
}

/**
 * Classify a discovered skill's `filePath` into the directory it came from.
 *
 * Order matters: `~/.agents/skills` and the workflow package path are both
 * checked before the generic global/project directories, since a skill under
 * `~/.agents/skills` would otherwise also satisfy no other check and a skill
 * under an ancestor `.agents/skills` is the catch-all once every named
 * directory has been ruled out.
 */
export function labelSkillSource(filePath: string, cwd: string): SkillSourceLabel {
  if (isUnder(filePath, WORKFLOW_SKILLS_PATH)) return "Workflow package";
  if (isUnder(filePath, join(PI_AGENT_DIR, "skills"))) return "Global (Semla agent dir)";
  if (isUnder(filePath, join(resolve(cwd), ".pi", "skills"))) return "Project (.pi/skills)";
  if (isUnder(filePath, join(homedir(), ".agents", "skills"))) return "Personal (~/.agents/skills)";
  return "Project (.agents/skills)";
}
