/**
 * Turns the agent event stream into everything a prompt turn does in response:
 * client events, snapshot persistence, project links, background-run bookkeeping.
 *
 * Split out of runPiPrompt, where it was an inline subscriber that mutated three
 * `let` bindings the turn's `finally` block read five hundred lines later. The
 * state it writes is now the explicit `TurnBackgroundState` it is handed, so the
 * decision that depends on it — see `decideContinuation` — is testable without
 * standing up a pi session.
 */

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import { readCodeMapResult } from "@/lib/code-map/tool-result";
import { retainBackgroundSession } from "@/lib/pi/background-sessions";
import { detach, sessionLog } from "@/lib/pi/session-log";
import {
  asWorkflowSnapshot,
  getBackgroundWorkflowRunId,
  liveSnapshot,
  type EmitSessionEvent,
} from "@/lib/pi/session-events";
import {
  attachWrittenProject,
  writtenPath,
} from "@/lib/pi/session-project-attach";
import {
  persistBackgroundWorkflowStart,
  persistWorkflowSnapshot,
} from "@/lib/pi/session-persistence";
import { setSessionRepos } from "@/lib/pi/wiki-session-repo";
import { getParams, summarizeArguments } from "@/lib/pi/transcript";
import {
  claimBackgroundRun,
  noteDeliveredDuringPrompt,
  setBackgroundRun,
  type TurnBackgroundState,
} from "@/lib/pi/turn-background-state";
import type { SessionDebugWriter } from "@/lib/pi/debug-writer";

/** Only what the router needs to keep a background run's session alive. */
type RetainableSession = { dispose(): void };

export type TurnEventRouter = {
  /**
   * Persist and announce a background run that has just started.
   *
   * Shared with the bridge run notifier, which dispatches runs that never
   * surface as a `workflow` tool event: both have to reach Supabase and the
   * workflow panel the same way, or a bridge-dispatched ingest shows up in
   * neither.
   */
  announceBackgroundRun: (runId: string) => void;
  /** Claim a bridge-dispatched run as the one this turn watches, if unclaimed. */
  claimBridgeRun: (runId: string) => boolean;
  /** Subscriber to hand to `session.subscribe`. */
  onSessionEvent: (event: AgentSessionEvent) => void;
  /**
   * Persist progress for a bridge-dispatched run.
   *
   * These runs report by snapshot polled off the workflow manager rather than
   * through a tool event, and they are not emitted to the client: the workflow
   * panel picks them up from Supabase.
   */
  persistBridgeSnapshot: (snapshot: unknown, runId: string) => void;
};

export const createTurnEventRouter = ({
  agentCwd,
  attachedThisTurn,
  debug,
  emit,
  piRuntimeSessionId,
  semlaSessionId,
  session,
  state,
  turnRepoSlugs,
}: {
  /**
   * Where the agent is running, so a relative path from `edit` or `write`
   * resolves to the project it actually touched. See session-cwd.ts.
   */
  agentCwd: string;
  /** Projects this turn has already linked; written as tool results arrive. */
  attachedThisTurn: Set<string>;
  debug: SessionDebugWriter;
  emit: EmitSessionEvent;
  /** Pi's own session id, which is the key the wiki bridge reads repos under. */
  piRuntimeSessionId: string;
  semlaSessionId: string;
  session: RetainableSession;
  state: TurnBackgroundState;
  turnRepoSlugs: () => string[];
}): TurnEventRouter => {
  // Which file each in-flight edit/write is about to change. The path is only
  // available on the *start* event and success is only known on the *end*
  // event, so the two are bridged by toolCallId — a failed edit must not
  // attach the project it aimed at.
  const pendingWrittenPaths = new Map<string, string>();

  const announceBackgroundRun = (runId: string) => {
    detach(
      semlaSessionId,
      "persist run start",
      persistBackgroundWorkflowStart(semlaSessionId, runId),
    );
    emit({
      runId,
      startedAt: new Date().toISOString(),
      type: "workflow-started",
    });
  };

  const persistSnapshot = (
    snapshot: unknown,
    runId: string | undefined,
    origin: "background" | "foreground",
    label = "persist snapshot",
  ) => {
    const parsed = asWorkflowSnapshot(snapshot);
    if (!parsed) return undefined;
    const enriched = liveSnapshot(parsed, runId);
    debug.onWorkflowSnapshot(enriched, origin);
    detach(
      semlaSessionId,
      label,
      persistWorkflowSnapshot(semlaSessionId, enriched, origin),
    );
    return enriched;
  };

  const claimBridgeRun = (runId: string) => {
    if (!claimBackgroundRun(state, runId)) return false;
    retainBackgroundSession(runId, session);
    sessionLog(semlaSessionId, "bridge primary run — background continuation armed", {
      run: runId,
    });
    return true;
  };

  const onToolStart = (
    event: Extract<AgentSessionEvent, { type: "tool_execution_start" }>,
  ) => {
    sessionLog(semlaSessionId, "tool start", { tool: event.toolName });
    debug.onToolStart(event.toolName);
    // toolCallId and a server timestamp let the client place this call on the
    // timeline now, instead of waiting for the entries to be persisted at the
    // end of the turn. The same summary/params the transcript derives keep the
    // live marker labelled identically to the persisted one that replaces it.
    const summary = summarizeArguments(event.args);
    const params = getParams(event.args);
    emit({
      at: new Date().toISOString(),
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      type: "tool-start",
      ...(summary ? { summary } : {}),
      ...(params ? { params } : {}),
    });

    // Held until the call ends, because only the end says whether it worked.
    const written = writtenPath(event.toolName, event.args);
    if (written) pendingWrittenPaths.set(event.toolCallId, written);
  };

  const onToolEnd = (
    event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>,
  ) => {
    sessionLog(semlaSessionId, "tool end", { tool: event.toolName });
    debug.onToolEnd(event.toolName, event.result);
    emit({
      at: new Date().toISOString(),
      isError: Boolean(event.isError),
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      type: "tool-end",
    });

    // A file in a project was actually changed, so the session relates to
    // that project. Detached: the link is a record of what happened, and
    // failing to write it must not fail the turn that earned it.
    const written = pendingWrittenPaths.get(event.toolCallId);
    if (written) {
      pendingWrittenPaths.delete(event.toolCallId);
      if (!event.isError) {
        detach(
          semlaSessionId,
          "attach written project",
          attachWrittenProject(
            semlaSessionId,
            written,
            attachedThisTurn,
            agentCwd,
          ).then(
            // A page captured after the agent strays into a second repo
            // should say so, so republish rather than wait for the next turn.
            () => setSessionRepos(piRuntimeSessionId, turnRepoSlugs()),
          ),
        );
      }
    }

    // code_map is Semla's own tool, so its structured map survives in the
    // result rather than having been flattened to text. Forwarded verbatim:
    // the panel draws the object the type checker produced.
    if (event.toolName === "code_map") {
      const map = readCodeMapResult(event.result);
      if (map) emit({ map, type: "code-map" });
    }

    if (event.toolName === "workflow") {
      const backgroundRunId = getBackgroundWorkflowRunId(event.result);
      if (backgroundRunId) {
        // The agent's own `workflow` call is the authoritative signal, so it
        // supersedes any claim a bridge dispatch got in first.
        setBackgroundRun(state, backgroundRunId);
        sessionLog(semlaSessionId, "workflow background detected", {
          run: backgroundRunId,
        });
        retainBackgroundSession(backgroundRunId, session);
        announceBackgroundRun(backgroundRunId);
      }

      // Deliberately the run id off *this* result, not the turn's claimed run:
      // a foreground workflow has none, and its snapshot must not be stamped
      // with an unrelated background run's id.
      const enriched = persistSnapshot(event.result, backgroundRunId, "foreground");
      if (enriched) emit({ snapshot: enriched, type: "workflow-snapshot" });
    }
  };

  const onSessionEvent = (event: AgentSessionEvent) => {
    if (
      event.type === "message_start" &&
      event.message.role === "custom" &&
      event.message.customType === "workflow-result"
    ) {
      noteDeliveredDuringPrompt(state);
      sessionLog(semlaSessionId, "workflow result delivered inside prompt turn");
    }

    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;

      if (update.type === "text_delta") {
        debug.onAssistantDelta(update.delta);
        emit({ delta: update.delta, type: "assistant-delta" });
      }
    }

    if (event.type === "tool_execution_start") {
      onToolStart(event);
    }

    if (event.type === "tool_execution_end") {
      onToolEnd(event);
    }

    if (event.type === "tool_execution_update" && event.toolName === "workflow") {
      const enriched = persistSnapshot(
        event.partialResult,
        state.runId,
        "foreground",
      );
      if (enriched) emit({ snapshot: enriched, type: "workflow-snapshot" });
    }
  };

  const persistBridgeSnapshot = (snapshot: unknown, runId: string) => {
    persistSnapshot(snapshot, runId, "background", "persist bridge snapshot");
  };

  return {
    announceBackgroundRun,
    claimBridgeRun,
    onSessionEvent,
    persistBridgeSnapshot,
  };
};
