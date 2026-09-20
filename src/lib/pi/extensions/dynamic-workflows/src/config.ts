/**
 * Configuration constants for pi-dynamic-workflows.
 */

/** Maximum number of agents allowed per workflow run. */
export const MAX_AGENTS_PER_RUN = 1000;

/** Default timeout for a single agent in milliseconds. null means no hard timeout. */
export const DEFAULT_AGENT_TIMEOUT_MS = null;

/** Maximum concurrent agents (matches Claude Code limit). */
export const MAX_CONCURRENCY = 16;

/** Maximum automatic retry attempts after a recoverable agent failure. */
export const MAX_AGENT_RETRIES = 3;

/** Legacy project-relative directory for persisted workflow run state. New writes use workflowProjectPaths(). */
export const WORKFLOW_RUNS_DIR = ".pi/workflows/runs";

/** Legacy project-relative directory for saved workflow commands. New writes use workflowProjectPaths(). */
export const WORKFLOW_SAVED_DIR = ".pi/workflows/saved";

/**
 * Subdirectory of Semla's state directory holding all workflow state.
 *
 * Joined onto `semlaStateDir()`, not onto `homedir()`. This was `~/.pi/
 * workflows` and then briefly `~/.semla/workflows`, and both were wrong for
 * the same reason `orient-status/paths.ts` records about its own first
 * implementation: workflow settings, saved workflows, run journals and the
 * tier config are this application's own state, and `.semla-state/` is where
 * that goes. It is already gitignored, `SEMLA_STATE_DIR` already relocates it,
 * and it sits beside the debug and session artifacts an operator already looks
 * in. A home directory bought nothing this module needs.
 *
 * `~/.semla` still holds one thing, and deliberately: `agent-dir.ts` keeps
 * credentials outside the tree because `auth.json` in a gitignored in-repo
 * directory is still one `git add -f` from a commit. No workflow state is a
 * credential.
 *
 * Only ever join this via `workflowHomeDir()`, which applies the
 * PI_WORKFLOW_HOME override. Anything that spells out a root itself opts out
 * of that override, and silently: it keeps working, against the operator's
 * real state, which is how the tier config came to be written by the test
 * suite.
 */
export const WORKFLOW_STATE_SUBDIR = "workflows";

/**
 * The two places the user-level workflow home lived before it came in-repo,
 * home-relative and newest first.
 *
 * Read by `migrateLegacyWorkflowHome()` only, and only to relocate one of them
 * once. Nothing else may resolve against these: a read fallback would keep a
 * host-owned directory live indefinitely, which is the state the move removes.
 * Ordered so an operator who ran the intermediate `~/.semla/workflows` build
 * carries forward that copy rather than the older `~/.pi` one it superseded.
 */
export const LEGACY_WORKFLOW_HOME_RELATIVE_DIRS = [
  ".semla/workflows",
  ".pi/workflows",
] as const;

/** Basename of the model tiers config, shared by its user and project locations. */
export const MODEL_TIERS_FILENAME = "model-tiers.json";

/**
 * Root of project-scoped, committable workflow config, relative to a cwd.
 *
 * Deliberately NOT under `.semla-state/`, which every other path here now
 * resolves into: that directory is gitignored, and this one file is meant to
 * be committed and reviewed. It is the one piece of workflow config that
 * belongs to a repository rather than to an install — see
 * `getProjectModelTierConfigPath()`.
 */
export const WORKFLOW_PROJECT_RELATIVE_DIR = ".semla/workflows";

/**
 * Project-relative model tiers config, joined onto a cwd. The user-level path
 * is not this constant — see `getModelTierConfigPath()`, which derives it from
 * `workflowHomeDir()` so it can be redirected.
 */
export const MODEL_TIERS_FILE = `${WORKFLOW_PROJECT_RELATIVE_DIR}/${MODEL_TIERS_FILENAME}`;

/**
 * Where a repository's committed tier config lived before the move. Read only
 * by `getProjectModelTierConfigPath()`'s migration, for the same reason the
 * legacy home constant exists: a checkout can be older than this change.
 */
export const LEGACY_MODEL_TIERS_FILE = `.pi/workflows/${MODEL_TIERS_FILENAME}`;

/** Default keyword that arms workflows mode from interactive input. */
export const DEFAULT_KEYWORD_TRIGGER_WORD = "workflow";

/** Normalize a user-configured keyword trigger word. */
export function normalizeKeywordTriggerWord(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const word = value.trim();
  if (!word || word.startsWith("/") || /\s/.test(word)) return undefined;
  return word;
}

/**
 * Named workflow subagent definitions directory. Resolved project-relative
 * (cwd/.pi/agents), plus user-level at `~/.pi/agent/agents/` (the primary
 * location, via `getAgentDir()` in agent-registry.ts) with the legacy
 * `~/.pi/agents/` (this constant, home-relative) scanned as a deprecated
 * fallback. Project entries win on name collision, then the primary user
 * location, then the legacy one. Each `*.md` file is an agent definition
 * (frontmatter + body prompt).
 */
export const AGENTS_DIR = ".pi/agents";
