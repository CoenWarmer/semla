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
import { retainBackgroundSession } from "@/lib/pi/background/background-sessions";
import { candidateProjects, isMutatingTool } from "@/lib/pi/artifacts/artifact-attribution";
import { captureAndRecord } from "@/lib/pi/artifacts/artifact-record";
import { projectOfPath } from "@/lib/pi/workspace/project-of-path";
import { getWorkspaceProjects } from "@/lib/pi/workspace/workspace";
import { PI_WORKSPACE_ROOT } from "@/lib/pi/runtime/runtime-config";
import { projectAbsolutePath, sessionProjects } from "@/lib/pi/session/session-project";
import { accessesFromToolCall } from "@/lib/pi/file-access/access-from-tool-call";
import {
  existenceCache,
  toFileAccess,
} from "@/lib/pi/file-access/access-paths";
import {
  MAIN_AGENT,
  workspaceForSession,
} from "@/lib/pi/file-access/access-timeline";
import { LIVE_TURN_ID } from "@/lib/pi/file-access/access-types";
import { detach, sessionLog } from "@/lib/pi/session/session-log";
import {
  asWorkflowSnapshot,
  getBackgroundWorkflowRunId,
  liveSnapshot,
  type EmitSessionEvent,
} from "@/lib/pi/session/session-events";
import {
  attachWrittenProject,
  writtenPath,
} from "@/lib/pi/session/session-project-attach";
import {
  persistBackgroundWorkflowStart,
  persistWorkflowSnapshot,
} from "@/lib/pi/session/session-persistence";
import { setSessionRepos } from "@/lib/pi/wiki/wiki-session-repo";
import {
  getParams,
  summarizeArguments,
  textFromToolResultContent,
} from "@/lib/pi/transcript";
import { WIKI_RECALL_CUSTOM_TYPE } from "@/lib/pi/wiki/wiki-recall-message";
import {
  claimBackgroundRun,
  noteDeliveredDuringPrompt,
  setBackgroundRun,
  type TurnBackgroundState,
} from "@/lib/pi/background/turn-background-state";
import type { SessionDebugWriter } from "@/lib/pi/debug-writer";
import type { HostTelemetry } from "@/lib/pi/telemetry/host-recorder";

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
  host,
  piRuntimeSessionId,
  semlaSessionId,
  session,
  state,
  turnId,
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
  /**
   * Turn and tool spans. Driven from here because these tool events are
   * already handled here — nothing extra is observed, and a span cannot drift
   * out of step with the marker the client is shown for the same call.
   */
  host: HostTelemetry;
  /** Pi's own session id, which is the key the wiki bridge reads repos under. */
  piRuntimeSessionId: string;
  semlaSessionId: string;
  session: RetainableSession;
  state: TurnBackgroundState;
  /**
   * The durable id minted for this turn (src/lib/pi/session/turn-id.ts), or
   * null for a programmatic continuation that has none. Stamped onto every
   * artifact this turn's tool calls produce — see ArtifactCore.turnId.
   */
  turnId: string | null;
  turnRepoSlugs: () => string[];
}): TurnEventRouter => {
  // Which file each in-flight edit/write is about to change. The path is only
  // available on the *start* event and success is only known on the *end*
  // event, so the two are bridged by toolCallId — a failed edit must not
  // attach the project it aimed at.
  const pendingWrittenPaths = new Map<string, string>();

  /**
   * Each in-flight call's arguments, for the file-access derivation.
   *
   * The same bridging problem as `pendingWrittenPaths`, for a different reason:
   * arguments arrive on the start event, `details` on the end, and a `read`'s
   * offset and an `edit`'s changed line are one each.
   */
  const pendingArgs = new Map<string, unknown>();

  /**
   * Where a live access's path resolves.
   *
   * `agentCwd` comes from the turn rather than from `workspaceForSession`'s own
   * derivation of it, so a live access and its persisted twin cannot disagree
   * about what a relative path meant — the turn's is the one the agent actually
   * ran in.
   */
  const accessWorkspace = {
    ...workspaceForSession(semlaSessionId),
    agentCwd,
  };
  const accessExists = existenceCache();

  // Which assistant round trip is currently streaming. A turn is not one
  // model reply — `message_start`/`message_end` bracket each round trip the
  // model makes (text, then a tool call, then more text, ...), and each
  // becomes its own persisted message once the turn ends. Deltas and tool
  // events between one `message_start` and the next all belong to the same
  // round, so they are stamped with this id — see `round-start` in
  // session-events.ts for why the client needs the boundary at all.
  let currentRoundId: string | null = null;
  let roundSeq = 0;

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

  /**
   * Resolve a mutating call's candidate projects to snapshot.
   *
   * edit/write already carry a resolved written path; bash does not, so its
   * candidates are the project owning `agentCwd` plus this session's already
   * linked projects — see candidateProjects' docblock in artifact-attribution.ts
   * for why a `cd ../other && git commit` is a real case to cover.
   */
  const captureCandidateProjects = async ({
    toolName,
    writtenPath: written,
  }: {
    agentCwd: string;
    semlaSessionId: string;
    toolName: string;
    writtenPath: string | null;
  }): Promise<{ projectPath: string; root: string }[]> => {
    const workspaceProjects = await getWorkspaceProjects();
    const projectNames = new Set(workspaceProjects.map((project) => project.name));

    const writtenProject = written
      ? projectOfPath(written, PI_WORKSPACE_ROOT, projectNames, agentCwd)
      : null;
    const cwdProject = projectOfPath(agentCwd, PI_WORKSPACE_ROOT, projectNames);

    const links = await sessionProjects(semlaSessionId);

    const candidates = candidateProjects({
      cwdProject,
      linkedProjects: links.map((link) => link.path),
      toolName,
      writtenPath: writtenProject,
    });

    return candidates.map((projectPath) => ({
      projectPath,
      root: projectAbsolutePath({ path: projectPath }),
    }));
  };

  const onToolStart = (
    event: Extract<AgentSessionEvent, { type: "tool_execution_start" }>,
    // The round trip this call belongs to, per the message_start seen just
    // before it. Never actually null in practice — a tool call cannot fire
    // before the assistant message that requested it has started — but the
    // fallback keeps a tool call from a future event ordering the current
    // agent-core version does not produce from being silently dropped by
    // groupConversation for want of a messageId.
    roundId: string | null,
  ) => {
    sessionLog(semlaSessionId, "tool start", { tool: event.toolName });
    debug.onToolStart(event.toolName);
    // toolCallId and a server timestamp let the client place this call on the
    // timeline now, instead of waiting for the entries to be persisted at the
    // end of the turn. The same summary/params the transcript derives keep the
    // live marker labelled identically to the persisted one that replaces it.
    host.toolStarted(event.toolCallId, { name: event.toolName });
    const summary = summarizeArguments(event.args);
    const params = getParams(event.args);
    emit({
      at: new Date().toISOString(),
      roundId: roundId ?? "live-round-0",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      type: "tool-start",
      ...(summary ? { summary } : {}),
      ...(params ? { params } : {}),
    });

    // Held until the call ends, because only the end says whether it worked.
    const written = writtenPath(event.toolName, event.args);
    if (written) pendingWrittenPaths.set(event.toolCallId, written);

    // Held for the same reason the file-access derivation runs at tool end:
    // the arguments are only on the start event and the `details` only on the
    // end, and both are needed to say which lines were touched.
    pendingArgs.set(event.toolCallId, event.args);
  };

  const onToolEnd = (
    event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>,
    roundId: string | null,
  ) => {
    sessionLog(semlaSessionId, "tool end", { tool: event.toolName });
    debug.onToolEnd(event.toolName, event.result);
    host.toolEnded(event.toolCallId, { isError: Boolean(event.isError) });
    const isError = Boolean(event.isError);
    // Same extraction and length limits the persisted transcript applies to a
    // toolResult message (transcript.ts's getToolCalls) — so the live drawer
    // shows the identical text the persisted one replaces it with, rather
    // than nothing until the turn ends and the refetch lands.
    const resultText = textFromToolResultContent(event.result?.content);
    emit({
      at: new Date().toISOString(),
      ...(isError ? { errorText: resultText.slice(0, 1000) } : {}),
      isError,
      ...(resultText ? { resultText: resultText.slice(0, 4000) } : {}),
      roundId: roundId ?? "live-round-0",
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

    // What this call produced: a diff, a commit, or a PR. Only on success —
    // a failed call changed nothing worth recording — and only for the tools
    // that can mutate a working copy at all. Detached: the snapshot chain in
    // artifact-snapshot-cache.ts must never cost the turn, and its failures
    // cost only this call's artifact, not the turn that earned it.
    if (!event.isError && isMutatingTool(event.toolName)) {
      const capturedArgs = pendingArgs.get(event.toolCallId);
      const capturedWritten = writtenPath(event.toolName, capturedArgs);
      const command =
        event.toolName === "bash" &&
        typeof capturedArgs === "object" &&
        capturedArgs !== null &&
        typeof (capturedArgs as { command?: unknown }).command === "string"
          ? (capturedArgs as { command: string }).command
          : null;
      detach(
        semlaSessionId,
        "capture artifacts",
        captureCandidateProjects({
          agentCwd,
          semlaSessionId,
          toolName: event.toolName,
          writtenPath: capturedWritten,
        }).then((projects) =>
          captureAndRecord({
            attribution: "tool-call",
            command,
            // Both halves of a diff's role (diff-role.ts): what the agent
            // declared on the call, and the path it wrote. Read from the
            // args this router already captured for attribution, so the
            // role costs no extra bookkeeping.
            declaredRole:
              typeof capturedArgs === "object" && capturedArgs !== null
                ? (capturedArgs as { role?: unknown }).role
                : null,
            output: resultText || null,
            projects,
            writtenPath: capturedWritten,
            roundId: roundId ?? "live-round-0",
            sessionId: semlaSessionId,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            turnId,
          }),
        ),
      );
    }

    /**
     * What this call read or wrote, for the review panel's follow mode.
     *
     * Only on success: a failed `read` opened nothing, and following the agent
     * onto a path it could not open is worse than not following it.
     *
     * Detached from correctness — a derivation that throws must not fail the
     * turn — but not detached in time: it is emitted on the same event as
     * `tool-end`, so the panel learns about a read at the moment it happened
     * rather than at the end of the turn.
     */
    const args = pendingArgs.get(event.toolCallId);
    pendingArgs.delete(event.toolCallId);
    if (!isError) {
      try {
        const raw = accessesFromToolCall({
          arguments: args,
          details: (event.result as { details?: unknown } | null | undefined)
            ?.details,
          id: event.toolCallId,
          name: event.toolName,
        });

        if (raw.length > 0) {
          emit({
            accesses: raw.map((access, index) =>
              toFileAccess(
                access,
                {
                  agent: MAIN_AGENT,
                  at: new Date().toISOString(),
                  callId: event.toolCallId,
                  id:
                    raw.length > 1
                      ? `${event.toolCallId}#${index}`
                      : event.toolCallId,
                  turnId: LIVE_TURN_ID,
                },
                accessWorkspace,
                accessExists,
              ),
            ),
            type: "file-access",
          });
        }
      } catch (error) {
        // The shell parser runs over whatever the model typed and the
        // resolution step touches the filesystem, so neither is guaranteed
        // total. Losing a scrubber stop is a cosmetic failure; losing the turn
        // that produced it is not, and the history endpoint re-derives all of
        // this from disk once the entry is persisted.
        sessionLog(semlaSessionId, "file-access derivation failed", {
          error: error instanceof Error ? error.message : String(error),
          tool: event.toolName,
        });
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

    // The wiki extension's before_agent_start hook injects this right after
    // the user message, before the model streams anything — pi's own
    // runAgentLoop emits message_start/message_end for every entry in that
    // batch up front (see wiki-recall-message.ts). Surfacing it live, rather
    // than waiting for the turn to end and the transcript to refetch, is what
    // this event exists for: a person watching the reply stream in should not
    // have to reload to see what informed it.
    if (
      event.type === "message_start" &&
      event.message.role === "custom" &&
      event.message.customType === WIKI_RECALL_CUSTOM_TYPE
    ) {
      const content = event.message.content;
      const text = typeof content === "string" ? content : "";
      if (text.trim()) emit({ content: text, type: "wiki-recall" });
    }

    // A model round trip, which is what step 7 of the plan wanted from
    // `pi.ai.request` — a span pi declares but never emits. Only the
    // assistant's own messages: a tool result is appended as a message too,
    // and it is not a round trip.
    //
    // It is also the client's only signal for where one round trip ends and
    // the next begins: without `roundId`, every round trip's text deltas
    // concatenated into one blob and every tool call carried one placeholder
    // id, so a turn that said something, called a tool, then said more,
    // rendered live as one flattened answer with every tool chip stuck at the
    // end — correct once persisted rows replaced it, but visibly wrong while
    // still streaming. See `round-start` in session-events.ts.
    if (event.type === "message_start" && event.message.role === "assistant") {
      host.stepStarted();
      roundSeq += 1;
      currentRoundId = `live-round-${roundSeq}`;
      emit({ roundId: currentRoundId, type: "round-start" });
    }

    if (event.type === "message_end" && event.message.role === "assistant") {
      const usage = (
        event.message as { usage?: { cost?: { total?: number }; totalTokens?: number } }
      ).usage;
      host.stepEnded(
        usage
          ? { cost: usage.cost?.total ?? 0, tokens: usage.totalTokens ?? 0 }
          : undefined,
      );
    }

    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;

      if (update.type === "text_delta" && currentRoundId) {
        debug.onAssistantDelta(update.delta);
        emit({ delta: update.delta, roundId: currentRoundId, type: "assistant-delta" });
      }
    }

    if (event.type === "tool_execution_start") {
      onToolStart(event, currentRoundId);
    }

    if (event.type === "tool_execution_end") {
      onToolEnd(event, currentRoundId);
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
