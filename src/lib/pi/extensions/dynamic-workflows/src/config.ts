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
 * Root of user-level workflow state, relative to the home directory.
 *
 * `.semla/`, not `.pi/`. `~/.pi` is the `pi` CLI's own configuration home,
 * shared with every other tool on the machine that invokes `pi`; workflow
 * settings, saved workflows, run journals and the tier config are Semla's
 * own state and are indistinguishable there from state an unrelated `pi`
 * session left behind. `agent-dir.ts` moved credentials and the model catalog
 * out for that reason and this followed it, late — see
 * `migrateLegacyWorkflowHome()` in workflow-paths.ts for what happens to a
 * home that predates the move.
 *
 * Only ever join this onto a home directory via `workflowHomeDir()`, which
 * applies the PI_WORKFLOW_HOME override. Anything that spells out
 * `homedir()` itself opts out of that override, and silently: it keeps
 * working, against the operator's real state, which is how the tier config
 * came to be written by the test suite.
 */
export const WORKFLOW_HOME_RELATIVE_DIR = ".semla/workflows";

/**
 * Where the user-level workflow home lived before it moved out of `~/.pi`.
 *
 * Read by `migrateLegacyWorkflowHome()` only, and only to relocate it once.
 * Nothing else may resolve against this: a read fallback would keep the host's
 * `pi` directory live indefinitely, which is the state the move removes.
 */
export const LEGACY_WORKFLOW_HOME_RELATIVE_DIR = ".pi/workflows";

/** Basename of the model tiers config, shared by its user and project locations. */
export const MODEL_TIERS_FILENAME = "model-tiers.json";

/**
 * Root of project-scoped, committable workflow config, relative to a cwd.
 *
 * Mirrors `WORKFLOW_HOME_RELATIVE_DIR` one level up so the two locations for
 * the same file are recognizably the same layout. Distinct from the
 * `.semla-state/` this application writes its own runtime state into: that is
 * gitignored, and the file under this directory is meant to be committed.
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
export const LEGACY_MODEL_TIERS_FILE = `${LEGACY_WORKFLOW_HOME_RELATIVE_DIR}/${MODEL_TIERS_FILENAME}`;

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
