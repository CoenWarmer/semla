/**
 * User-level settings for the architecture-awareness extensions (items 1, 2,
 * 3, 4 of docs/plans/architecture-awareness.md).
 *
 * Deliberately one flag per item, all independently toggleable — the whole
 * point per the plan's constraints is A/B testing each behaviour on its own.
 * Follows the same load/normalize/save shape as
 * `dynamic-workflows/src/workflow-settings.ts`, stored in its own file so this
 * feature's config isn't entangled with the workflow extension's.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { PI_AGENT_DIR } from "@/lib/pi/agent-dir";

import { DEFAULT_PLACEMENT_MAX_TOKENS } from "./placement-rules";

export interface ArchitectureAwarenessSettings {
  /** Item 1: inject PLACEMENT.md into the system prompt. Default true. */
  placementPromptEnabled?: boolean;
  /** Token cap for PLACEMENT.md before session start fails loudly. */
  placementMaxTokens?: number;
  /** Item 2: persist and re-inject SPEC.md before edit-tool calls. Default true. */
  specPersistenceEnabled?: boolean;
  /** Item 3: replace built-in edit/write with target_module/rationale-checked versions. Default true. */
  placementToolsEnabled?: boolean;
  /**
   * Item 4: shell command run after each accepted edit/write, in the target
   * repo's cwd. Its failure is fed back to the agent as a tool result, never
   * fatal. Absent/empty means the enforcement loop is skipped entirely.
   */
  enforcementCommand?: string;
  /** Item 4 toggle, independent of whether a command is configured. Default true. */
  enforcementEnabled?: boolean;
}

const SETTINGS_FILE_NAME = "architecture-awareness-settings.json";

export function getArchitectureAwarenessSettingsPath(): string {
  return join(PI_AGENT_DIR, SETTINGS_FILE_NAME);
}

/** Per-project override, alongside PLACEMENT.md/SPEC.md in the target repo. */
export function getProjectArchitectureAwarenessSettingsPath(cwd: string): string {
  return join(cwd, ".semla", SETTINGS_FILE_NAME);
}

const DEFAULTS: Required<
  Pick<
    ArchitectureAwarenessSettings,
    | "placementPromptEnabled"
    | "placementMaxTokens"
    | "specPersistenceEnabled"
    | "placementToolsEnabled"
    | "enforcementEnabled"
  >
> = {
  enforcementEnabled: true,
  placementMaxTokens: DEFAULT_PLACEMENT_MAX_TOKENS,
  placementPromptEnabled: true,
  placementToolsEnabled: true,
  specPersistenceEnabled: true,
};

export function loadArchitectureAwarenessSettings(
  cwd?: string,
): Required<
  Pick<
    ArchitectureAwarenessSettings,
    | "placementPromptEnabled"
    | "placementMaxTokens"
    | "specPersistenceEnabled"
    | "placementToolsEnabled"
    | "enforcementEnabled"
  >
> &
  Pick<ArchitectureAwarenessSettings, "enforcementCommand"> {
  const global = readSettings(getArchitectureAwarenessSettingsPath());
  const project = cwd ? readSettings(getProjectArchitectureAwarenessSettingsPath(cwd)) : {};
  const merged = { ...global, ...project };

  return {
    enforcementCommand: merged.enforcementCommand,
    enforcementEnabled: merged.enforcementEnabled ?? DEFAULTS.enforcementEnabled,
    placementMaxTokens: merged.placementMaxTokens ?? DEFAULTS.placementMaxTokens,
    placementPromptEnabled: merged.placementPromptEnabled ?? DEFAULTS.placementPromptEnabled,
    placementToolsEnabled: merged.placementToolsEnabled ?? DEFAULTS.placementToolsEnabled,
    specPersistenceEnabled: merged.specPersistenceEnabled ?? DEFAULTS.specPersistenceEnabled,
  };
}

export function saveArchitectureAwarenessSettings(
  settings: ArchitectureAwarenessSettings,
  path: string = getArchitectureAwarenessSettingsPath(),
): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const existing = readObject(path);
  writeFileSync(path, `${JSON.stringify({ ...existing, ...settings }, null, 2)}\n`, "utf-8");
}

function readSettings(path: string): ArchitectureAwarenessSettings {
  if (!existsSync(path)) return {};
  try {
    return normalizeSettings(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return {};
  }
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

function normalizeSettings(value: unknown): ArchitectureAwarenessSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const settings: ArchitectureAwarenessSettings = {};

  if (typeof raw.placementPromptEnabled === "boolean") {
    settings.placementPromptEnabled = raw.placementPromptEnabled;
  }
  if (
    typeof raw.placementMaxTokens === "number" &&
    Number.isFinite(raw.placementMaxTokens) &&
    raw.placementMaxTokens > 0
  ) {
    settings.placementMaxTokens = Math.floor(raw.placementMaxTokens);
  }
  if (typeof raw.specPersistenceEnabled === "boolean") {
    settings.specPersistenceEnabled = raw.specPersistenceEnabled;
  }
  if (typeof raw.placementToolsEnabled === "boolean") {
    settings.placementToolsEnabled = raw.placementToolsEnabled;
  }
  if (typeof raw.enforcementEnabled === "boolean") {
    settings.enforcementEnabled = raw.enforcementEnabled;
  }
  if (typeof raw.enforcementCommand === "string" && raw.enforcementCommand.trim()) {
    settings.enforcementCommand = raw.enforcementCommand.trim();
  }

  return settings;
}
