/**
 * Every file a session's agents touched, in order.
 *
 * Built from the session file rather than from the transcript the client
 * already has: `getParams` keeps only scalar arguments and `buildTranscript`
 * never reads `details`, so an `edit`'s `firstChangedLine` and a
 * `code_resolve`'s target — both present on disk — are gone by the time the
 * browser sees a tool call.
 *
 * Turns are bounded by user messages, using the same `TurnNode.id` the branch
 * graph does, so "this turn" means the same thing in both panels.
 */

import { PI_SESSION_DIR, PI_WORKSPACE_ROOT } from "@/lib/pi/runtime-config";
import { resolveSessionCwd } from "@/lib/pi/session-cwd";
import { readSessionEntries, type SessionFileEntry } from "@/lib/pi/session-file";
import { readSessionMeta } from "@/lib/pi/session-meta";
import { ROOT_TURN_ID } from "@/lib/pi/session-turn-graph";

import { accessesFromToolCall } from "./access-from-tool-call";
import {
  existenceCache,
  toFileAccess,
  type AccessWorkspace,
} from "./access-paths";
import type {
  AccessAgent,
  FileAccess,
  FileAccessTimeline,
  TimelineTurn,
} from "./access-types";

export const MAIN_AGENT: AccessAgent = { id: "main", label: "Main" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const messageOf = (entry: SessionFileEntry): Record<string, unknown> | null =>
  isRecord(entry.message) ? entry.message : null;

/**
 * `details` from every tool result, by the call it answers.
 *
 * A first pass, because a result is a later entry than the call it belongs to
 * and `edit`'s changed line only exists on the result.
 */
function detailsByCallId(
  entries: readonly SessionFileEntry[],
): Map<string, unknown> {
  const details = new Map<string, unknown>();

  for (const entry of entries) {
    const message = messageOf(entry);
    if (!message || message.role !== "toolResult") continue;

    const callId = message.toolCallId;
    if (typeof callId !== "string") continue;

    details.set(callId, message.details);
  }

  return details;
}

export interface EntryAccessOptions {
  agent: AccessAgent;
  workspace: AccessWorkspace;
  exists: (absolutePath: string) => boolean;
  /**
   * Turn to attribute every access to. Omit for the host session, whose turns
   * are read from its own user messages; supply one for a subagent, whose work
   * all belongs to the turn that started the workflow.
   */
  fixedTurnId?: string;
}

/**
 * Accesses from a run of pi entries, oldest first.
 *
 * Shared by the host session and by subagent transcripts, which pi writes in
 * the same format — so a subagent's `bash` reads are found by the same parser
 * rather than by a second, weaker one reading the run file's compacted history.
 */
export function accessesFromEntries(
  entries: readonly SessionFileEntry[],
  options: EntryAccessOptions,
): { accesses: FileAccess[]; turns: TimelineTurn[] } {
  const details = detailsByCallId(entries);
  const accesses: FileAccess[] = [];
  const turns: TimelineTurn[] = [];
  let turnId = options.fixedTurnId ?? ROOT_TURN_ID;

  for (const entry of entries) {
    const message = messageOf(entry);
    if (!message || !entry.id) continue;

    if (message.role === "user" && options.fixedTurnId === undefined) {
      turnId = entry.id;
      turns.push({ at: entry.timestamp ?? "", id: turnId });
      continue;
    }

    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;

    const at = entry.timestamp ?? "";

    for (const part of message.content) {
      if (!isRecord(part) || part.type !== "toolCall") continue;
      if (typeof part.name !== "string") continue;

      const callId = typeof part.id === "string" ? part.id : `${entry.id}-call`;
      const found = accessesFromToolCall({
        arguments: part.arguments,
        details: details.get(callId),
        id: callId,
        name: part.name,
      });

      found.forEach((raw, index) => {
        accesses.push(
          toFileAccess(
            raw,
            {
              agent: options.agent,
              at,
              // One call can touch several files — a shell command, or a
              // resolve with more than one target — so the call id alone is
              // not unique enough to key a list on.
              id: found.length > 1 ? `${callId}#${index}` : callId,
              turnId,
            },
            options.workspace,
            options.exists,
          ),
        );
      });
    }
  }

  return { accesses, turns };
}

/**
 * The workspace a session's paths resolve against.
 *
 * The agent cwd is derived the way the turn itself derives it, so a path the
 * agent wrote relative to where it was running resolves to the same file here.
 */
export function workspaceForSession(
  sessionId: string,
  dir = PI_SESSION_DIR,
  workspaceRoot = PI_WORKSPACE_ROOT,
): AccessWorkspace {
  const projects = (readSessionMeta(sessionId, dir)?.projects ?? []).map(
    (link) => link.path,
  );

  return {
    agentCwd: resolveSessionCwd(projects, workspaceRoot),
    projects,
    workspaceRoot,
  };
}

export interface TimelineOptions {
  leafId?: string | null;
  dir?: string;
  workspaceRoot?: string;
  exists?: (absolutePath: string) => boolean;
}

/**
 * The host agent's accesses for one session.
 *
 * Subagent accesses are folded in by `withSubagentAccesses` rather than here,
 * so a session with no workflow runs pays nothing for the machinery that finds
 * them.
 */
export function buildFileAccessTimeline(
  sessionId: string,
  options: TimelineOptions = {},
): FileAccessTimeline {
  const dir = options.dir ?? PI_SESSION_DIR;
  const rows = readSessionEntries(sessionId, dir, options.leafId) ?? [];
  const workspace = workspaceForSession(
    sessionId,
    dir,
    options.workspaceRoot ?? PI_WORKSPACE_ROOT,
  );

  const { accesses, turns } = accessesFromEntries(
    rows.map((row) => row.payload.entry),
    {
      agent: MAIN_AGENT,
      exists: options.exists ?? existenceCache(),
      workspace,
    },
  );

  return {
    accesses,
    agents: accesses.length > 0 ? [MAIN_AGENT] : [],
    turns,
  };
}
