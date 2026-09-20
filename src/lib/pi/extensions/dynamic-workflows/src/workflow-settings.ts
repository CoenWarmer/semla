/**
 * User-level settings for pi-dynamic-workflows.
 *
 * Stored separately from Pi's own settings.json so extension preferences remain
 * stable without depending on host-internal config shape.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  MAX_AGENT_RETRIES,
  MAX_CONCURRENCY,
  normalizeKeywordTriggerWord,
} from "./config.ts";
import { workflowHomeDir, workflowProjectPaths } from "./workflow-paths.ts";

export interface WorkflowSettings {
  keywordTriggerEnabled?: boolean;
  /** Literal keyword that arms workflows mode from interactive input. */
  keywordTriggerWord?: string;
  defaultAgentTimeoutMs?: number | null;
  /**
   * Default hard token budget applied to runs that don't pass their own
   * `tokenBudget` (#68). null explicitly means "no budget" (useful in a
   * project override to cancel a global budget); omitted also means no budget.
   */
  defaultTokenBudget?: number | null;
  /** Default max concurrent agents per run. Clamped to the runtime maximum. */
  defaultConcurrency?: number;
  /** Default retry attempts after recoverable agent failures. */
  defaultAgentRetries?: number;
  /**
   * Persist each workflow subagent transcript as a real pi session file
   * under the project's own session directory (`<project>/.semla-sessions/`,
   * the same directory the main session writes to), keyed by the project
   * cwd. Default true: set to false to keep subagent sessions in-memory, so
   * only the compacted history embedded in the run JSON survives.
   */
  persistAgentSessions?: boolean;
  /**
   * Character cap on a delivered background-run result's JSON-dump fallback
   * before truncation (default 400). String results and `verdict`/`report`/
   * `summary`/`synthesis` fields are never truncated.
   */
  deliveredResultMaxChars?: number;
  /**
   * Extra tool names to deny in workflow subagent sessions, on top of the
   * always-on `workflow`/`workflow_control` defaults (#107). Use it to block
   * other recursive-orchestration tools you have installed (e.g. a pi-subagents
   * tool) so a subagent can't fan out through them.
   */
  excludeSubagentTools?: string[];
  /**
   * Enable/disable the read-router extension's tool-result compression.
   * Default true (omitting the field also enables it).
   */
  /**
   * Enable/disable the jev-gate extension's per-turn narrowing of the tool and
   * skill set. Default false — reversed by the operator on 2026-09-19 after
   * a live run against this repository's own session showed the gate
   * narrowing the operator's own tools mid-conversation, before the
   * threshold and floor (see gate-decision.ts's ALWAYS_ON_TOOLS) had a
   * track record. Omitting the field leaves it off; set true explicitly to
   * turn it on.
   */
  jevGateEnabled?: boolean;
  /**
   * Probability at or above which Jev's per-candidate answer keeps a tool or
   * skill. Default 0.3, calibrated against live probes — see the docblock in
   * `jev-gate/gate-decision.ts` for the four prompts it was chosen from.
   */
  jevGateThreshold?: number;
  /** Deadline for one decisions call, in ms. Default 2000. */
  jevGateTimeoutMs?: number;
  /**
   * Enable/disable the read-router extension's tool-result compression.
   * Default true (omitting the field also enables it).
   */
  readRouterEnabled?: boolean;
  /**
   * Model used for summarisation. Must be a "provider/modelId" string.
   * Default "anthropic/claude-haiku-4-5-20251001".
   */
  readRouterModel?: string;
  /**
   * Minimum line count for a `read` result to be compressed. Default 300.
   */
  readRouterThresholdLines?: number;
  /**
   * Minimum char count for a `bash` result to be compressed. Default 3000.
   */
  readRouterThresholdChars?: number;
}

export interface WorkflowSettingsStore {
  load(): WorkflowSettings;
  save(settings: WorkflowSettings): void;
}

export interface WorkflowSettingsOptions {
  /** Explicit settings path, primarily for tests and migrations. */
  settingsPath?: string;
  /** Project cwd whose project-level settings should override global settings. */
  cwd?: string;
  /** Explicit project settings path, primarily for tests. */
  projectSettingsPath?: string;
  /** Save destination when using saveWorkflowSettings with cwd. Default: global. */
  scope?: "global" | "project";
}

/** Path to the user-level workflow settings JSON file (.semla-state/workflows/settings.json). */
export function getWorkflowSettingsPath(): string {
  return join(workflowHomeDir(), "settings.json");
}

/** Path to this project's optional workflow settings override. */
export function getWorkflowProjectSettingsPath(cwd: string): string {
  return workflowProjectPaths(cwd).settingsPath;
}

/** Load settings from disk. Missing, corrupt, or invalid files resolve to {}. */
export function loadWorkflowSettings(
  settingsPathOrOptions?: string | WorkflowSettingsOptions,
): WorkflowSettings {
  const options = normalizeOptions(settingsPathOrOptions);
  const globalSettings = readSettings(
    options.settingsPath ?? getWorkflowSettingsPath(),
  );
  const projectPath =
    options.projectSettingsPath ??
    (options.cwd ? getWorkflowProjectSettingsPath(options.cwd) : undefined);
  if (!projectPath) return globalSettings;
  return { ...globalSettings, ...readSettings(projectPath) };
}

/** Merge known settings into the user-level settings file. */
export function saveWorkflowSettings(
  settings: WorkflowSettings,
  settingsPathOrOptions?: string | WorkflowSettingsOptions,
): void {
  const options = normalizeOptions(settingsPathOrOptions);
  const projectPath =
    options.projectSettingsPath ??
    (options.cwd ? getWorkflowProjectSettingsPath(options.cwd) : undefined);
  const path =
    options.scope === "project" && projectPath
      ? projectPath
      : (options.settingsPath ?? getWorkflowSettingsPath());
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const existing = readObject(path);
  writeFileSync(
    path,
    `${JSON.stringify({ ...existing, ...normalizeSettings(settings) }, null, 2)}\n`,
    "utf-8",
  );
}

/** Save a global preference and update an existing project override if one is present. */
export function saveWorkflowSettingsForCwd(
  settings: WorkflowSettings,
  cwd: string,
): void {
  saveWorkflowSettings(settings);
  const projectPath = getWorkflowProjectSettingsPath(cwd);
  if (existsSync(projectPath)) {
    saveWorkflowSettings(settings, {
      projectSettingsPath: projectPath,
      scope: "project",
    });
  }
}

function normalizeOptions(
  settingsPathOrOptions?: string | WorkflowSettingsOptions,
): WorkflowSettingsOptions {
  return typeof settingsPathOrOptions === "string"
    ? { settingsPath: settingsPathOrOptions }
    : (settingsPathOrOptions ?? {});
}

function readSettings(path: string): WorkflowSettings {
  if (!existsSync(path)) return {};
  try {
    return normalizeSettings(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return {};
  }
}

function normalizeSettings(value: unknown): WorkflowSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const settings: WorkflowSettings = {};
  if (typeof raw.keywordTriggerEnabled === "boolean") {
    settings.keywordTriggerEnabled = raw.keywordTriggerEnabled;
  }
  const keywordTriggerWord = normalizeKeywordTriggerWord(
    raw.keywordTriggerWord,
  );
  if (keywordTriggerWord !== undefined)
    settings.keywordTriggerWord = keywordTriggerWord;
  if (raw.defaultAgentTimeoutMs === null) {
    settings.defaultAgentTimeoutMs = null;
  } else if (
    typeof raw.defaultAgentTimeoutMs === "number" &&
    Number.isFinite(raw.defaultAgentTimeoutMs) &&
    raw.defaultAgentTimeoutMs > 0
  ) {
    settings.defaultAgentTimeoutMs = raw.defaultAgentTimeoutMs;
  }
  if (raw.defaultTokenBudget === null) {
    settings.defaultTokenBudget = null;
  } else {
    const defaultTokenBudget = normalizeInteger(
      raw.defaultTokenBudget,
      1,
      Number.MAX_SAFE_INTEGER,
    );
    if (defaultTokenBudget !== undefined)
      settings.defaultTokenBudget = defaultTokenBudget;
  }
  const defaultConcurrency = normalizeInteger(
    raw.defaultConcurrency,
    1,
    MAX_CONCURRENCY,
  );
  if (defaultConcurrency !== undefined)
    settings.defaultConcurrency = defaultConcurrency;
  const defaultAgentRetries = normalizeInteger(
    raw.defaultAgentRetries,
    0,
    MAX_AGENT_RETRIES,
  );
  if (defaultAgentRetries !== undefined)
    settings.defaultAgentRetries = defaultAgentRetries;
  // progressPanelMode / progressPanelMaxAgents are deliberately not parsed:
  // they configured the pi-tui progress panel, which Semla never rendered. An
  // existing settings file may still carry them; they are ignored rather than
  // rejected, since a stale key is not a reason to fail a settings read.
  if (typeof raw.persistAgentSessions === "boolean") {
    settings.persistAgentSessions = raw.persistAgentSessions;
  }
  const deliveredResultMaxChars = normalizeInteger(
    raw.deliveredResultMaxChars,
    1,
    1_000_000,
  );
  if (deliveredResultMaxChars !== undefined)
    settings.deliveredResultMaxChars = deliveredResultMaxChars;
  if (Array.isArray(raw.excludeSubagentTools)) {
    const names = raw.excludeSubagentTools.filter(
      (t): t is string => typeof t === "string" && t.trim().length > 0,
    );
    if (names.length) settings.excludeSubagentTools = names;
  }
  if (typeof raw.jevGateEnabled === "boolean") {
    settings.jevGateEnabled = raw.jevGateEnabled;
  }
  if (
    typeof raw.jevGateThreshold === "number" &&
    Number.isFinite(raw.jevGateThreshold) &&
    raw.jevGateThreshold >= 0 &&
    raw.jevGateThreshold <= 1
  ) {
    // Out of range is dropped rather than clamped: a threshold of 5 is a
    // mistake, and clamping it to 1 would silently gate away every tool.
    settings.jevGateThreshold = raw.jevGateThreshold;
  }
  const jevGateTimeoutMs = normalizeInteger(raw.jevGateTimeoutMs, 1, 60_000);
  if (jevGateTimeoutMs !== undefined) settings.jevGateTimeoutMs = jevGateTimeoutMs;
  if (typeof raw.readRouterEnabled === "boolean") {
    settings.readRouterEnabled = raw.readRouterEnabled;
  }
  if (typeof raw.readRouterModel === "string" && raw.readRouterModel.trim()) {
    settings.readRouterModel = raw.readRouterModel.trim();
  }
  const readRouterThresholdLines = normalizeInteger(raw.readRouterThresholdLines, 1, 100_000);
  if (readRouterThresholdLines !== undefined) settings.readRouterThresholdLines = readRouterThresholdLines;
  const readRouterThresholdChars = normalizeInteger(raw.readRouterThresholdChars, 1, 10_000_000);
  if (readRouterThresholdChars !== undefined) settings.readRouterThresholdChars = readRouterThresholdChars;
  return settings;
}

function normalizeInteger(
  value: unknown,
  min: number,
  max: number,
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min)
    return undefined;
  return Math.min(max, Math.floor(value));
}

function readObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
