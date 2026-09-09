/**
 * Assembling one subagent session: its tool set, its transcript persistence,
 * and the resource loader every subagent of a run shares.
 *
 * Split out of agent.ts so its run loop reads as a sequence of named steps.
 * The tool functions are pure and tested as such (agent-session.test.ts); the
 * persistence helpers take the project cwd as an argument instead of reading it
 * off a WorkflowAgent instance, which is what makes them callable from a test
 * against a temp directory.
 *
 * One caveat for anyone writing those tests: `warnedPersistSecrets` below is a
 * process-wide warn-once flag with no reset hook, so a second call in the same
 * process is silent by design. Assert on the returned SessionManager, not on
 * the warning.
 */

import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createCodingTools,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { applyToolPolicy } from "./agent-registry.ts";
import { WorkflowError, WorkflowErrorCode } from "./errors.ts";
import {
  createStructuredOutputTool,
  type StructuredOutputCapture,
} from "./structured-output.ts";

/**
 * Orchestration tools ALWAYS denied to workflow subagents. The `workflow` and
 * `workflow_control` tools are registered globally by the extension, so — unless
 * excluded — a subagent's session sees them and can start its own independent
 * background workflows. Those nested runs recursively fan out and are NOT bounded
 * by the parent run's maxAgents / concurrency / progress / accounting, and can
 * drain a shared provider quota and pile up paused runs (#107). Callers may deny
 * additional tool names via WorkflowAgentOptions.excludeTools.
 */
export const DEFAULT_EXCLUDED_SUBAGENT_TOOLS = ["workflow", "workflow_control"];

/**
 * The full subagent tool denylist: the always-on defaults plus any names the
 * caller added (via WorkflowAgentOptions.excludeTools) or set on the injected
 * session options. Extracted so the merge — and its order — is unit-testable;
 * a spread-order regression that dropped the defaults would slip past a test
 * that only asserts the constant. The SDK dedupes, so overlap is harmless.
 */
export function subagentExcludedTools(
  extra?: string[],
  sessionExclude?: string[],
): string[] {
  return [
    ...DEFAULT_EXCLUDED_SUBAGENT_TOOLS,
    ...(sessionExclude ?? []),
    ...(extra ?? []),
  ];
}

/**
 * Coding tools rebuilt for another directory, keeping everything else.
 *
 * Coding tools capture their cwd when constructed, so a per-call cwd needs its
 * own. Anything the host contributed — a named toolset's tools, for instance —
 * has no such tie and must survive the swap.
 */
export function mergeRelocatedCodingTools(
  baseTools: ToolDefinition[],
  relocated: ToolDefinition[],
): ToolDefinition[] {
  const relocatedNames = new Set(relocated.map((tool) => tool.name));
  return [...relocated, ...baseTools.filter((tool) => !relocatedNames.has(tool.name))];
}

/**
 * Emitted at most once per process when persistAgentSessions is enabled and a
 * session is actually persisted: full subagent transcripts (which may include
 * secrets or other sensitive context) are being written to disk. Surface the
 * privacy trade-off at run time, not only in the docs.
 */
let warnedPersistSecrets = false;
function warnPersistSecretsOnce(sessionDir: string): void {
  if (warnedPersistSecrets) return;
  warnedPersistSecrets = true;
  console.warn(
    `[workflow] persistAgentSessions is ON: full subagent transcripts (which may include secrets or other sensitive context) are being written to disk under ${sessionDir}. Disable persistAgentSessions if that isn't intended.`,
  );
}

/**
 * Build the resource loader a whole run's subagents share (#109).
 *
 * Without a resourceLoader, createAgentSession() builds a fresh
 * DefaultResourceLoader per subagent and reloads it — re-running EVERY installed
 * extension factory each time (verified: N subagents → N factory runs). Each
 * such factory that arms a load-time timer/listener then roots its subagent
 * session forever, because AgentSession.dispose() emits no session_shutdown to
 * run the cleanup — the dominant #109 leak, and one our own extension
 * (UsageLimitScheduler) can trigger.
 *
 * `noExtensions: true` skips loading host extensions; skills, prompts, and
 * AGENTS.md context still load. The subagent keeps the tools this workflow
 * hands it via `customTools` (coding tools + any toolset like web-research) —
 * those are unaffected. What it loses is HOST EXTENSION-REGISTERED tools (MCP
 * bridges, browser tools, anything a host extension added via ctx.registerTool):
 * pre-change a subagent session inherited those from the full host extension
 * set, now it does not, so an agentType `tools` allowlist naming one matches
 * nothing. This is a deliberate trade-off — it also structurally kills recursive
 * orchestration in subagents (no extension runtime at all), beyond the name-level
 * #107 denylist — and must be release-noted. `createAgentSession` with a shared
 * resourceLoader is a supported embedding pattern.
 *
 * The caller memoizes the returned promise for exactly one run (see
 * WorkflowAgent.getSharedResourceLoader); this function itself holds no state,
 * so a failed build is the caller's to discard rather than a poisoned module.
 */
export async function buildSharedResourceLoader(
  cwd: string,
  agentDir: string,
): Promise<DefaultResourceLoader> {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.create(cwd, agentDir),
    noExtensions: true,
  });
  await loader.reload();
  return loader;
}

/** Best-effort write probe: throws if the session directory isn't actually writable. */
export function assertSessionDirWritable(dir: string): void {
  const probePath = join(dir, `.write-probe-${randomUUID()}`);
  writeFileSync(probePath, "");
  unlinkSync(probePath);
}

/**
 * Session manager for one subagent run. File-backed (persisted under the
 * standard sessions dir, keyed by the runner's project cwd — never a
 * per-call worktree cwd) when persistAgentSessions is on; in-memory otherwise.
 *
 * SessionManager.create() only creates the session directory — the SDK writes
 * the session file lazily (synchronous fs calls, uncaught) on the first
 * assistant message, deep inside session.prompt(). A failure there would
 * otherwise throw mid-run and abort this subagent. Probe writability up front
 * so any create/write failure (permissions, disk full) degrades this single
 * agent to an in-memory session instead — the run continues, just without a
 * persisted transcript.
 */
export function createSubagentSessionManager(
  cwd: string,
  persistAgentSessions: boolean,
): SessionManager {
  if (!persistAgentSessions) return SessionManager.inMemory();
  try {
    const manager = SessionManager.create(cwd);
    assertSessionDirWritable(manager.getSessionDir());
    warnPersistSecretsOnce(manager.getSessionDir());
    return manager;
  } catch (error) {
    console.warn(
      `[workflow] persistAgentSessions: could not persist this agent's session (${
        error instanceof Error ? error.message : String(error)
      }); continuing with an in-memory session`,
    );
    return SessionManager.inMemory();
  }
}

/** The parts of an agent() call that decide its tool set. */
export interface SubagentToolRequest {
  cwd?: string;
  tools?: ToolDefinition[];
  toolNames?: string[];
  disallowedToolNames?: string[];
  systemTools?: ToolDefinition[];
  schema?: TSchema;
}

/**
 * The tool set for one subagent run: the run's base tools rebound to this
 * call's cwd, filtered by the agentType policy, then the exempt additions.
 *
 * Order is the contract here, and each step exists for a reported failure:
 * the policy filter runs BEFORE structured_output is added, so a restrictive
 * allowlist never strips the schema tool; system tools (e.g. shared-store)
 * bypass the filter for the same reason.
 *
 * `capture` is filled in by the structured_output tool when the model calls it.
 */
export function buildSubagentTools(
  options: SubagentToolRequest,
  baseTools: ToolDefinition[],
  runCwd: string,
  agentCwd: string,
  // oxlint-disable-next-line no-explicit-any
  capture: StructuredOutputCapture<any>,
): ToolDefinition[] {
  // Per-call cwd (e.g. a worktree) needs coding tools bound to that directory,
  // since tools capture their cwd at construction and can't be relocated.
  // Only the coding tools are rebuilt: replacing the whole set discarded
  // everything a host toolset had contributed, so an agent that named its own
  // cwd silently lost them. A capture agent that ran git in the repository it
  // was orienting therefore had no wiki tools, while its siblings did.
  const tools =
    runCwd === agentCwd
      ? baseTools
      : mergeRelocatedCodingTools(baseTools, createCodingTools(runCwd));

  // Apply the agentType tool policy BEFORE adding structured_output, so a
  // restrictive allowlist never strips the schema tool.
  const customTools: ToolDefinition[] = applyToolPolicy(
    [...tools, ...(options.tools ?? [])],
    options.toolNames,
    options.disallowedToolNames,
  );

  // System tools bypass the allowlist/denylist filter (e.g. shared-store tools).
  if (options.systemTools?.length) {
    customTools.push(...options.systemTools);
  }

  if (options.schema) {
    // Strict OpenAI-compatible providers (e.g. DeepSeek) reject a tool whose top-level
    // parameters schema isn't a JSON object with a transport-level 400, before any of
    // the runner's SCHEMA_NONCOMPLIANCE/empty-output classification ever runs. Fail fast
    // here instead, so a script's non-object opts.schema surfaces a clear workflow error.
    const schemaType = (options.schema as { type?: unknown }).type;
    if (schemaType !== "object") {
      throw new WorkflowError(
        `agent() opts.schema must be a top-level JSON object schema (type: "object") — got type: ${schemaType ?? "undefined"}; wrap array/primitive results in an object, e.g. { type: "object", properties: { items: <your schema> } }`,
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false },
      );
    }
    customTools.push(
      createStructuredOutputTool({
        schema: options.schema,
        capture,
      }) as unknown as ToolDefinition,
    );
  }

  return customTools;
}
