import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { mkdir } from "node:fs/promises";

import {
  releaseBackgroundSession,
  retainBackgroundSession,
} from "@/lib/pi/background-sessions";
import { registerNotifier, type AskUserPayload } from "@/lib/pi/ask-user-bridge";
import { DEFAULT_SYSTEM_PROMPT } from "@/lib/pi/system-prompt";
import {
  applyBranchTarget,
  resolveBranchTarget,
} from "@/lib/pi/session-branch";
import { readCodeMapResult } from "@/lib/code-map/tool-result";
import {
  attachWrittenProject,
  writtenPath,
} from "@/lib/pi/session-project-attach";
import type { CodeMap } from "@/lib/code-map/types";
import {
  createSessionDebugWriter,
  type SessionDebugWriter,
} from "@/lib/pi/debug-writer";
import {
  PI_AGENT_DIR,
  PI_SESSION_DIR,
  PI_TOOLS,
  PI_WORKSPACE_ROOT,
  REFRESH_EXTENSIONS_PER_SESSION,
  WORKFLOW_SKILLS_PATH,
  getPiRuntimeConfig,
} from "@/lib/pi/runtime-config";
import {
  assertExtensionLoad,
  assertExtensionPathsExist,
  assertManifestIsCoherent,
  buildExtensionLoadReport,
  extensionPathsInLoadOrder,
} from "@/lib/pi/extension-manifest";
import {
  ACTIVE_WORKFLOW_MANAGER,
  BRIDGE_RUN_STARTED,
  clearSlot,
  readSlot,
  writeSlot,
  type BridgeRunNotifier,
} from "@/lib/pi/extension-contract";
import { followBridgeRunProgress } from "@/lib/pi/bridge-run-progress";
import { recordExtensionLoad } from "@/lib/pi/extension-health";
import {
  getLiveSession,
  releaseLiveSession,
  retainLiveSession,
} from "@/lib/pi/live-sessions";
import { stampSessionWikiPages } from "@/lib/pi/wiki-repo-stamp";
import {
  clearSessionRepo,
  setSessionRepos,
} from "@/lib/pi/wiki-session-repo";
import {
  createSessionFile,
  ensurePiSession,
  fetchPersistedEntries,
  fetchStuckBackgroundRuns,
  finalizeBackgroundRun,
  persistBackgroundWorkflowStart,
  persistEntry,
  persistWorkflowSnapshot,
  setSessionRunning,
  updateSessionTitle,
} from "@/lib/pi/session-persistence";
import {
  closeSessionStream,
  openSessionStream,
  publishToSessionStream,
} from "@/lib/pi/session-stream-store";
import {
  readWorkflowRun,
  workflowRunPath,
  type PersistedRunState,
} from "@/lib/pi/workflow-run-reader";
import { summarizeRunResult } from "@/lib/pi/workflow-result-summary";
import {
  historyToTurns,
  stampLiveTimestamps,
} from "@/lib/pi/workflow-snapshot-merge";
import { getParams, summarizeArguments } from "@/lib/pi/transcript";
import type { WorkflowSnapshot } from "@/types/workflow";

// Short prefix for terminal readability. sid = first 8 chars of semla session ID.
const log = (sid: string, msg: string, data?: Record<string, unknown>) => {
  const prefix = `[pi:session:${sid.slice(0, 8)}]`;
  if (data) {
    const pairs = Object.entries(data)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(" ");
    console.log(`${prefix} ${msg} · ${pairs}`);
  } else {
    console.log(`${prefix} ${msg}`);
  }
};

type PiSessionEntry = {
  id: string;
  parentId: string | null;
  timestamp: string;
  type: string;
};

type PiSessionEvent =
  | { text: string; type: "user-message" }
  | { delta: string; type: "assistant-delta" }
  | {
      at: string;
      params?: Record<string, string>;
      summary?: string;
      toolCallId: string;
      toolName: string;
      type: "tool-start";
    }
  | {
      at: string;
      isError: boolean;
      toolCallId: string;
      toolName: string;
      type: "tool-end";
    }
  | { map: CodeMap; type: "code-map" }
  | { runId: string; startedAt: string; type: "workflow-started" }
  | { snapshot: WorkflowSnapshot; type: "workflow-snapshot" }
  | { payload: AskUserPayload; type: "ask-user-question" }
  | { message: string; type: "error" }
  | { title: string; type: "title-updated" }
  | { type: "complete" };

export const asWorkflowSnapshot = (value: unknown): WorkflowSnapshot | undefined => {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  // Two shapes reach here. A tool result wraps the snapshot in `details`; a
  // snapshot read straight off the manager — which is how a bridge-dispatched
  // ingest reports progress — is already the thing itself. Requiring the
  // wrapper silently dropped every event from those runs.
  const details = "details" in value ? value.details : value;
  if (!details || typeof details !== "object" || !("agents" in details)) {
    return undefined;
  }

  const raw = details as WorkflowSnapshot;

  // The internal snapshot carries history[] on each agent (updated every 250ms
  // by onAgentHistory). Convert it to turns so tool calls appear in the timeline
  // during execution, not only after the agent completes.
  const agents = raw.agents.map((agent) => {
    if (agent.turns) return agent;
    const history = (agent as Record<string, unknown>)["history"];
    if (!Array.isArray(history) || history.length === 0) return agent;
    return {
      ...agent,
      turns: historyToTurns(
        history as Parameters<typeof historyToTurns>[0],
      ),
    };
  });

  return { ...raw, agents };
};

const getBackgroundWorkflowRunId = (value: unknown): string | undefined => {
  if (!value || typeof value !== "object" || !("details" in value)) {
    return undefined;
  }

  const details = value.details;
  if (
    !details ||
    typeof details !== "object" ||
    !("background" in details) ||
    details.background !== true ||
    !("runId" in details) ||
    typeof details.runId !== "string"
  ) {
    return undefined;
  }

  return details.runId;
};

const withRunId = (
  snapshot: WorkflowSnapshot,
  runId: string | undefined,
): WorkflowSnapshot =>
  !snapshot.runId && runId ? { ...snapshot, runId } : snapshot;

/**
 * Resolve a snapshot straight off the agent stream into one the timeline can
 * draw: attach the run id, then stamp the timing the manager never reports.
 * Without the stamp, every agent renders as a full-width bar until the polling
 * snapshot takes over.
 */
const liveSnapshot = (
  snapshot: WorkflowSnapshot,
  runId: string | undefined,
): WorkflowSnapshot => {
  const withId = withRunId(snapshot, runId);
  return withId.runId ? stampLiveTimestamps(withId.runId, withId) : withId;
};

// Run states after which no further agent work happens, so a result that has
// not been delivered yet never will be without intervention.
const TERMINAL_RUN_STATUSES = new Set(["aborted", "completed", "failed"]);

const isRunTerminal = (
  run: PersistedRunState | null,
): run is PersistedRunState =>
  run !== null && TERMINAL_RUN_STATUSES.has(run.status);

// The message pi-dynamic-workflows would have delivered for a finished run.
// Used by both recovery paths: the in-continuation watchdog and the
// next-prompt catch-up.
const finishedRunMessage = (run: PersistedRunState, runId: string): string => {
  const done = run.agents.filter((agent) => agent.status === "done").length;
  return [
    `✓ Background workflow "${run.workflowName}" finished (${done}/${run.agents.length} agents).`,
    "",
    summarizeRunResult(run.result, run.logs ?? []),
    "",
    `↳ Full result: ${workflowRunPath(PI_WORKSPACE_ROOT, runId)}`,
  ].join("\n");
};

const assertSandboxedRuntime = () => {
  const { hostDevelopmentEnabled, sandboxed } = getPiRuntimeConfig();

  if (!sandboxed && !hostDevelopmentEnabled) {
    throw new Error(
      "Pi must run inside the Semla sandbox. For local development only, set PI_ALLOW_HOST_DEV=true.",
    );
  }
};

const getConfiguredModel = async ({
  modelId,
  provider,
}: {
  modelId: string;
  provider: string;
}) => {
  const runtime = await ModelRuntime.create({ refreshOnCreate: false });

  // Workflow subagents resolve their own model through this runtime, and that
  // path reads the availability snapshot rather than models.json directly.
  // refreshOnCreate:false leaves the snapshot empty, which makes
  // hasConfiguredAuth() report false for a provider whose credentials are in
  // fact present — the subagent then fails with "No API key found for the
  // selected model" while this session's own model works fine. Warming it once
  // here is what pi-dynamic-workflows does for its own fallback runtime.
  await runtime.getAvailable().catch(() => {});

  const apiKey = process.env.PI_MODEL_API_KEY;

  if (apiKey) {
    await runtime.setRuntimeApiKey(provider, apiKey);
  }

  const model = runtime.getModel(provider, modelId);

  if (!model) {
    throw new Error(`Pi model ${provider}/${modelId} is not available.`);
  }

  return { model, modelId, provider, runtime };
};

const generateTitle = (text: string): string => {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= 60) return cleaned;
  const truncated = cleaned.slice(0, 60);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > 20 ? truncated.slice(0, lastSpace) : truncated).trimEnd() + "…";
};

// Tracks in-flight background continuations so a new prompt can abort the
// previous one cleanly, without disposing the session (which kills the shared
// bash executor and breaks concurrent sessions).
const bgAbortControllers = new Map<string, AbortController>();

/**
 * Tag every wiki page this turn wrote with the session's repo.
 *
 * Fire-and-forget by design: the wiki is a side product of the turn, so a slow
 * or failing stamp must not hold the SSE stream open or fail the prompt.
 */
const stampWikiRepo = (
  semlaSessionId: string,
  slugs: readonly string[],
  since: number,
) => {
  void stampSessionWikiPages({ slugs, since })
    .then((stamped) => {
      if (stamped.length > 0) {
        log(semlaSessionId, "wiki repo stamped", { pages: stamped.length });
      }
    })
    .catch((error: unknown) => {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(
        `[pi:session:${semlaSessionId.slice(0, 8)}] wiki repo stamp failed: ${msg}`,
      );
    });
};

/**
 * Start a persistence write we do not wait on, and absorb its failure.
 *
 * Every one of these is fire-and-forget, and none of them had a catch: a
 * transient Supabase outage — a Cloudflare 522, say — therefore surfaced as an
 * unhandled rejection, which Node terminates the process for by default. A
 * database blip could take the server down mid-turn.
 *
 * Dropping the write is the right outcome for all of them. Snapshots are
 * re-emitted continuously and the workflow panel polls Supabase besides, and a
 * missed title or running-flag update is corrected by the next turn. What is
 * not acceptable is losing it silently, so it is logged.
 */
const detach = (sid: string, what: string, work: Promise<unknown>): void => {
  void work.catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[pi:session:${sid.slice(0, 8)}] ${what} failed: ${message}`);
  });
};

/**
 * Interrupt a session's current turn.
 *
 * Aborts the agent loop and any background continuation waiting on it, then
 * clears the running flag so the UI stops showing a spinner for work that has
 * ended. Reports whether there was anything to stop, so the caller can tell
 * "stopped it" from "it had already finished".
 */
/**
 * Whether this process is actually working on a session.
 *
 * Both halves matter: a prompt turn holds a live session, and a background
 * continuation outlives that turn — it is armed in the same `finally` that
 * releases the live session, so checking only the registry would call every
 * background run finished.
 *
 * Used to spot a running flag left behind by a process that is no longer here.
 * A record claiming to run with neither of these is stale by definition,
 * because the loop it described lived in memory.
 */
export const isSessionActive = (semlaSessionId: string): boolean =>
  getLiveSession(semlaSessionId) !== undefined ||
  bgAbortControllers.has(semlaSessionId);

export const stopPiSession = async (semlaSessionId: string): Promise<boolean> => {
  const live = getLiveSession(semlaSessionId);
  const continuation = bgAbortControllers.get(semlaSessionId);

  if (!live && !continuation) return false;

  log(semlaSessionId, "stop requested");
  continuation?.abort();
  bgAbortControllers.delete(semlaSessionId);

  try {
    await live?.abort();
  } catch (error) {
    // An abort that fails still leaves the turn no longer wanted; the finally
    // in runPiPrompt is what actually tears the session down.
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[pi:session:${semlaSessionId.slice(0, 8)}] abort failed: ${message}`);
  }

  detach(semlaSessionId, "clear running", setSessionRunning(semlaSessionId, false));
  return true;
};

export const runPiPrompt = async ({
  editEntryId = null,
  model,
  onEvent,
  projects = [],
  semlaSessionId,
  systemPrompt,
  text,
  tools,
}: {
  /**
   * Replace this entry instead of continuing from the end of the conversation.
   * The leaf moves to its parent, so this turn becomes a sibling of it and the
   * original — with everything said in reply to it — is left on a path nothing
   * points at. Nothing is deleted; see session-branch.ts.
   */
  editEntryId?: string | null;
  model: { modelId: string; provider: string };
  onEvent: (event: PiSessionEvent) => void;
  /**
   * Repos this session works in, anchor first. Workspace-relative, which for a
   * first-level project is also its wiki slug.
   */
  projects?: readonly string[];
  semlaSessionId: string;
  systemPrompt?: string | null;
  text: string;
  tools: string[];
}) => {
  assertSandboxedRuntime();

  // Captured before any tool runs so the stamp sweep can tell the pages this
  // turn wrote from the ones an earlier orient left behind.
  const turnStartedAt = Date.now();

  openSessionStream(semlaSessionId);
  detach(semlaSessionId, "set running", setSessionRunning(semlaSessionId, true));

  const emit = (event: PiSessionEvent) => {
    publishToSessionStream(semlaSessionId, event);
    onEvent(event);
  };

  // Buffer the user's prompt as the first event so reconnecting clients can
  // show it optimistically before entries are persisted at end of turn.
  emit({ text, type: "user-message" });

  // If there's a background continuation waiting for a delivery that will now
  // go to this new session (pi-dynamic-workflows re-targets delivery to the
  // latest loaded session), abort it so it exits without disposing.
  bgAbortControllers.get(semlaSessionId)?.abort();
  bgAbortControllers.delete(semlaSessionId);

  const debug = createSessionDebugWriter(semlaSessionId);

  log(semlaSessionId, "prompt start", {
    model: `${model.provider}/${model.modelId}`,
    tools: tools.join(","),
  });
  debug.onPromptStart(text, `${model.provider}/${model.modelId}`, tools);

  const configuredModel = await getConfiguredModel(model);
  const piSession = await ensurePiSession(semlaSessionId, configuredModel);
  const persistedEntries = await fetchPersistedEntries(piSession.id);

  log(semlaSessionId, "session restored", { entries: persistedEntries.length });
  debug.onSessionRestored(persistedEntries.length);

  const sessionFile = await createSessionFile(semlaSessionId, persistedEntries);
  const sessionManager = SessionManager.open(
    sessionFile,
    PI_SESSION_DIR,
    PI_WORKSPACE_ROOT,
  );

  // Publish this session's repo so the wiki bridge can attribute the sources its
  // subagents capture. The key must be the *pi runtime* session id, which is
  // what the bridge reads from ctx.sessionManager on session_start — not
  // piSession.id, which is a Supabase pi_sessions row id. Keying it on the row
  // id made every lookup miss, so entity namespacing and capture-time
  // attribution silently did nothing while the turn-end sweep covered for them.
  // Before anything is appended: move the leaf so this turn lands where the
  // edited prompt was, rather than after the answer it is replacing.
  if (editEntryId) {
    applyBranchTarget(
      sessionManager,
      resolveBranchTarget(sessionManager.getEntries(), editEntryId),
    );
    log(semlaSessionId, "editing entry", { entry: editEntryId });
  }

  const piRuntimeSessionId = sessionManager.getSessionId();

  // The projects this turn has already linked. It belongs by subject beside
  // pendingWrittenPaths, where the tool events that fill it live, but it has to
  // be declared before turnRepoSlugs — which reads it and is called two lines
  // below. Declared after, every prompt threw on the temporal dead zone:
  // "Cannot access 'attachedThisTurn' before initialization".
  const attachedThisTurn = new Set<string>();

  /**
   * The repos this turn's wiki pages are attributed to: the session's anchor,
   * plus whatever it writes to along the way.
   *
   * Per turn rather than per session. Tagging every page with everything the
   * session has ever touched is more accurate than tagging them all with the
   * anchor, and still wrong for a turn that only worked in one of them — the
   * touched set is already accumulated for the link writes, so narrowing it
   * this way costs nothing.
   */
  const turnRepoSlugs = (): string[] =>
    [...projects, ...attachedThisTurn].filter(Boolean);

  setSessionRepos(piRuntimeSessionId, turnRepoSlugs());
  await mkdir(PI_AGENT_DIR, { recursive: true });
  const unregisterNotifier = registerNotifier(semlaSessionId, (payload) => {
    emit({ payload, type: "ask-user-question" });
  });

  // Validate before Pi ever sees the paths: a missing entry file or an
  // inconsistent manifest fails here with a fix attached, rather than becoming
  // a session that quietly runs without the tools it was supposed to have.
  assertManifestIsCoherent();
  assertExtensionPathsExist();

  const resourceLoader = new DefaultResourceLoader({
    additionalExtensionPaths: extensionPathsInLoadOrder(),
    additionalSkillPaths: [WORKFLOW_SKILLS_PATH],
    agentDir: PI_AGENT_DIR,
    cwd: PI_WORKSPACE_ROOT,
    appendSystemPrompt: [systemPrompt ?? DEFAULT_SYSTEM_PROMPT],
  });
  await resourceLoader.reload();
  // Second pass drops the loader's cached extension factories, so an edit to
  // one of Semla's own pi extensions is picked up by the next session instead
  // of needing the server restarted. See REFRESH_EXTENSIONS_PER_SESSION.
  if (REFRESH_EXTENSIONS_PER_SESSION) await resourceLoader.reload();

  const { extensionsResult, session } = await createAgentSession({
    cwd: PI_WORKSPACE_ROOT,
    model: configuredModel.model,
    modelRuntime: configuredModel.runtime,
    resourceLoader,
    sessionManager,
  });

  // Registered before the turn starts so a stop request has something to reach.
  retainLiveSession(semlaSessionId, session);

  const loadedExtensions = extensionsResult.extensions.map((e) => e.path);
  log(semlaSessionId, "extensions loaded", {
    loaded: loadedExtensions.length,
    errors: extensionsResult.errors.length,
  });

  // Extensions are only told they are live when pi emits `session_start`, and
  // pi emits it from bindExtensions() — which only its built-in CLI modes call.
  // Skipping it silently breaks background workflows: the pi-dynamic-workflows
  // factory calls suspendResultDelivery() and only resumeResultDelivery() on
  // session_start un-suspends it, so a finished run's result is queued in the
  // extension's in-memory pending list and never delivered to the conversation.
  // Bind before setActiveToolsByName so our explicit tool set stays authoritative
  // (the extension re-activates its own tools from its session_start handler).
  await session.bindExtensions({
    mode: "print",
    onError: (err) =>
      console.warn(
        `[pi:session:${semlaSessionId.slice(0, 8)}] extension error (${err.extensionPath}): ${err.error}`,
      ),
  });

  // Extension tools register during bindExtensions, and contract slots are
  // published from session_start handlers that Pi fires from the same call, so
  // this is the first moment the whole extension set can be checked against
  // what the manifest declared. Previously only a missing `workflow` tool was
  // fatal — every other extension could fail to load and the session would run
  // on silently without its tools.
  const boundTools = session.getActiveToolNames();
  const extensionReport = buildExtensionLoadReport({
    loadedPaths: loadedExtensions,
    loadErrors: extensionsResult.errors,
    registeredTools: boundTools,
  });

  // Publish before any throw, so a failed load is visible at /api/pi/health
  // rather than only in this process's logs.
  recordExtensionLoad(extensionReport);

  if (extensionReport.unexpectedErrors.length > 0) {
    // Not from the manifest — most likely a project-scope package configured in
    // the workspace's own .pi/settings.json. Worth seeing, not worth refusing
    // the session over.
    console.warn(
      `[pi:session:${semlaSessionId.slice(0, 8)}] non-manifest extension errors:\n${extensionReport.unexpectedErrors.join("\n")}`,
    );
  }

  if (!extensionReport.ok) {
    session.dispose();
    assertExtensionLoad(extensionReport);
  }

  // Capture extension tools before setActiveToolsByName restricts the set to
  // the user-selected built-ins, then re-add them so extension tools are always
  // available regardless of which built-ins the user has toggled on/off.
  const extensionTools = boundTools.filter(
    (t) => !(PI_TOOLS as readonly string[]).includes(t),
  );

  session.setActiveToolsByName([...tools, ...extensionTools]);
  const activeTools = session.getActiveToolNames();
  log(semlaSessionId, "active tools", { tools: activeTools.join(",") });

  // Recover background workflows whose delivery was lost (e.g. server restart mid-run).
  // Inject the result as a context message so Pi sees the completed workflow in this prompt.
  const stuckRuns = await fetchStuckBackgroundRuns(semlaSessionId);
  for (const { run_id } of stuckRuns) {
    const runState = readWorkflowRun(PI_WORKSPACE_ROOT, run_id);
    if (!runState || runState.status !== "completed") continue;
    try {
      await session.sendCustomMessage(
        {
          content: finishedRunMessage(runState, run_id),
          customType: "workflow-result",
          display: true,
        },
        { triggerTurn: false },
      );
      detach(semlaSessionId, "finalize run", finalizeBackgroundRun(semlaSessionId, run_id));
      log(semlaSessionId, "recovered stuck bg run", { run: run_id });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[pi:session:${semlaSessionId.slice(0, 8)}] bg run recovery failed for ${run_id}: ${msg}`,
      );
    }
  }

  // Which file each in-flight edit/write is about to change. The path is only
  // available on the *start* event and success is only known on the *end*
  // event, so the two are bridged by toolCallId — a failed edit must not
  // attach the project it aimed at.
  const pendingWrittenPaths = new Map<string, string>();

  let hasBackgroundWorkflow = false;
  let detectedBackgroundRunId: string | undefined;
  // A short background workflow can finish while the prompt turn is still
  // streaming. Pi then delivers the result as a follow-up inside this same
  // prompt() call, so there is nothing left for the background continuation to
  // wait for. Subscribed after the stuck-run recovery above, so the messages it
  // injects cannot be mistaken for this turn's delivery.
  let deliveredDuringPrompt = false;

  // Register per-turn notifier for bridge-dispatched background runs (e.g. from
  // wiki-ingest-bridge). These run via manager.startInBackground() directly and
  // never emit a `workflow` tool event, so they must notify via globalThis.
  // Primary runs (e.g. wiki-ingest batch coordinators) arm the background
  // continuation so the agent is notified once when the batch completes.
  const bridgeRunNotifier: BridgeRunNotifier = (runId, opts = {}) => {
    log(semlaSessionId, "bridge background run started", { run: runId });
    const startedAt = new Date().toISOString();
    detach(semlaSessionId, "persist run start", persistBackgroundWorkflowStart(semlaSessionId, runId));
    emit({ runId, startedAt, type: "workflow-started" });

    followBridgeRunProgress(readSlot(ACTIVE_WORKFLOW_MANAGER), runId, (snapshot) => {
      const parsed = asWorkflowSnapshot(snapshot);
      if (!parsed) return;
      const enriched = liveSnapshot(parsed, runId);
      debug.onWorkflowSnapshot(enriched, "background");
      detach(
        semlaSessionId,
        "persist bridge snapshot",
        persistWorkflowSnapshot(semlaSessionId, enriched, "background"),
      );
    });

    if (opts.primary && !hasBackgroundWorkflow) {
      hasBackgroundWorkflow = true;
      detectedBackgroundRunId = runId;
      retainBackgroundSession(runId, session);
      log(semlaSessionId, "bridge primary run — background continuation armed", { run: runId });
    }
  };
  writeSlot(BRIDGE_RUN_STARTED, bridgeRunNotifier);

  const unsubscribe = session.subscribe((event) => {
    if (
      event.type === "message_start" &&
      event.message.role === "custom" &&
      event.message.customType === "workflow-result"
    ) {
      deliveredDuringPrompt = true;
      log(semlaSessionId, "workflow result delivered inside prompt turn");
    }

    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;

      if (update.type === "text_delta") {
        debug.onAssistantDelta(update.delta);
        emit({ delta: update.delta, type: "assistant-delta" });
      }
    }

    if (event.type === "tool_execution_start") {
      log(semlaSessionId, "tool start", { tool: event.toolName });
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
    }

    if (event.type === "tool_execution_end") {
      log(semlaSessionId, "tool end", { tool: event.toolName });
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
            attachWrittenProject(semlaSessionId, written, attachedThisTurn).then(
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
          hasBackgroundWorkflow = true;
          detectedBackgroundRunId = backgroundRunId;
          log(semlaSessionId, "workflow background detected", {
            run: backgroundRunId,
          });
          retainBackgroundSession(backgroundRunId, session);
          const backgroundStartedAt = new Date().toISOString();
          detach(semlaSessionId, "persist run start", persistBackgroundWorkflowStart(semlaSessionId, backgroundRunId));
          emit({ runId: backgroundRunId, startedAt: backgroundStartedAt, type: "workflow-started" });
        }

        const snapshot = asWorkflowSnapshot(event.result);
        if (snapshot) {
          const enriched = liveSnapshot(snapshot, backgroundRunId);
          debug.onWorkflowSnapshot(enriched, "foreground");
          detach(semlaSessionId, "persist snapshot", persistWorkflowSnapshot(semlaSessionId, enriched, "foreground"));
          emit({ snapshot: enriched, type: "workflow-snapshot" });
        }
      }
    }

    if (
      event.type === "tool_execution_update" &&
      event.toolName === "workflow"
    ) {
      const snapshot = asWorkflowSnapshot(event.partialResult);
      if (snapshot) {
        const enriched = liveSnapshot(snapshot, detectedBackgroundRunId);
        debug.onWorkflowSnapshot(enriched, "foreground");
        detach(semlaSessionId, "persist snapshot", persistWorkflowSnapshot(semlaSessionId, enriched, "foreground"));
        emit({ snapshot: enriched, type: "workflow-snapshot" });
      }
    }
  });

  try {
    log(semlaSessionId, "prompting");
    await session.prompt(text);
    await session.agent.waitForIdle();
    const entries = session.sessionManager.getEntries();
    log(semlaSessionId, "prompt complete", {
      entries: entries.length,
      background: hasBackgroundWorkflow,
    });
    for (let i = 0; i < entries.length; i++) {
      const t0 = Date.now();
      await persistEntry(piSession.id, entries[i] as PiSessionEntry);
      debug.onPersistEntry(i + 1, entries.length, Date.now() - t0);
    }
    debug.onPromptComplete(entries.length, hasBackgroundWorkflow);
    if (persistedEntries.length === 0) {
      const title = generateTitle(text);
      // Fire-and-forget: a slow or failing Supabase write must not block the
      // SSE stream from closing, which would leave the client stuck pending.
      detach(semlaSessionId, "update title", updateSessionTitle(semlaSessionId, title));
      emit({ title, type: "title-updated" });
    }
    debug.onSseComplete();
    emit({ type: "complete" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    debug.onError(msg);
    throw new Error(msg);
  } finally {
    unsubscribe();
    unregisterNotifier();
    releaseLiveSession(semlaSessionId);
    clearSessionRepo(piRuntimeSessionId);
    // Clear the bridge run notifier so a stale reference can't fire after turn end.
    clearSlot(BRIDGE_RUN_STARTED);
    closeSessionStream(semlaSessionId);
    stampWikiRepo(semlaSessionId, turnRepoSlugs(), turnStartedAt);
    const settledDuringPrompt =
      deliveredDuringPrompt &&
      (!detectedBackgroundRunId ||
        isRunTerminal(readWorkflowRun(PI_WORKSPACE_ROOT, detectedBackgroundRunId)));

    if (hasBackgroundWorkflow && settledDuringPrompt) {
      // The workflow outran the prompt turn: its result is already delivered
      // and persisted above, so there is no continuation to wait for.
      log(semlaSessionId, "background workflow settled during prompt turn");
      if (detectedBackgroundRunId) {
        detach(semlaSessionId, "finalize run", finalizeBackgroundRun(semlaSessionId, detectedBackgroundRunId));
        releaseBackgroundSession(detectedBackgroundRunId);
      } else {
        session.dispose();
      }
      detach(semlaSessionId, "clear running", setSessionRunning(semlaSessionId, false));
    } else if (hasBackgroundWorkflow) {
      // Keep the session alive to receive background workflow progress and the
      // final report turn that pi delivers when the workflow completes.
      // is_running stays true until runBackgroundContinuation clears it.
      const bgAbort = new AbortController();
      bgAbortControllers.set(semlaSessionId, bgAbort);
      void runBackgroundContinuation(
        piSession.id,
        semlaSessionId,
        session,
        debug,
        detectedBackgroundRunId,
        bgAbort.signal,
        projects,
      );
    } else {
      log(semlaSessionId, "session disposed");
      session.dispose();
      detach(semlaSessionId, "clear running", setSessionRunning(semlaSessionId, false));
    }
  }
};

const runBackgroundContinuation = async (
  piSessionId: string,
  semlaSessionId: string,
  session: {
    subscribe: (cb: (event: unknown) => void) => () => void;
    agent: { waitForIdle: () => Promise<void> };
    sendCustomMessage: (
      message: { content: string; customType: string; display: boolean },
      options: { triggerTurn: boolean },
    ) => Promise<void>;
    sessionManager: { getEntries: () => unknown[] };
    dispose: () => void;
  },
  debug: SessionDebugWriter,
  runId: string | undefined,
  abortSignal: AbortSignal,
  projects: readonly string[],
) => {
  log(semlaSessionId, "bg continuation started");
  debug.onBgStart();

  // Background wiki ingest commits its pages after the prompt turn's own sweep
  // has already run, so the continuation needs a sweep of its own.
  const continuationStartedAt = Date.now();

  // Resolves when Pi starts generating the delivery turn (report after background completes).
  let resolveDelivery: (() => void) | undefined;
  const deliveryStarted = new Promise<void>((resolve) => {
    resolveDelivery = resolve;
  });
  const noteDelivery = (via: string) => {
    if (!resolveDelivery) return;
    log(semlaSessionId, "bg delivery detected · report turn starting", { via });
    debug.onBgDelivery();
    resolveDelivery();
    resolveDelivery = undefined;
  };

  const unsubscribeBg = session.subscribe((event: unknown) => {
    const e = event as Record<string, unknown>;

    if (e.type === "tool_execution_update" && e.toolName === "workflow") {
      const snapshot = asWorkflowSnapshot(e.partialResult);
      if (snapshot) {
        const enriched = liveSnapshot(snapshot, runId);
        debug.onWorkflowSnapshot(enriched, "background");
        detach(semlaSessionId, "persist snapshot", persistWorkflowSnapshot(semlaSessionId, enriched, "background"));
      }
    }

    if (e.type === "tool_execution_end" && e.toolName === "workflow") {
      const snapshot = asWorkflowSnapshot(e.result);
      if (snapshot) {
        const enriched = liveSnapshot(snapshot, runId);
        debug.onWorkflowSnapshot(enriched, "background");
        detach(semlaSessionId, "persist snapshot", persistWorkflowSnapshot(semlaSessionId, enriched, "background"));
      }
    }

    // Pi appends the workflow-result message the moment the extension delivers
    // it, before the report turn's first model round trip — the earliest and
    // most specific signal that delivery happened.
    if (e.type === "message_start") {
      const message = (e.message ?? {}) as Record<string, unknown>;
      if (message.customType === "workflow-result") {
        noteDelivery("workflow-result message");
      }
    }

    // Fallback: any assistant streaming after the prompt turn means pi is
    // generating the report, even if the delivery message was missed.
    if (e.type === "message_update") {
      noteDelivery("message_update");
      const update = (e.assistantMessageEvent ?? {}) as Record<string, unknown>;
      if (update.type === "text_delta" && typeof update.delta === "string") {
        debug.onAssistantDelta(update.delta);
      }
    }
  });

  // Watchdog. Pi owns delivery (the workflow extension sends the result back
  // and triggers the report turn), but if that ever fails — delivery suspended,
  // extension error, version skew — the conversation would sit frozen until
  // TIMEOUT_MS with a finished result on disk. Poll the run file and deliver it
  // ourselves once it has been terminal for a grace period without a report turn.
  const POLL_MS = 5 * 1000;
  const DELIVERY_GRACE_MS = 15 * 1000;
  let selfDelivering = false;
  let terminalSince: number | undefined;
  const watchdog = runId
    ? setInterval(() => {
        if (selfDelivering || !resolveDelivery) return;

        const run = readWorkflowRun(PI_WORKSPACE_ROOT, runId);
        if (!isRunTerminal(run)) {
          terminalSince = undefined;
          return;
        }

        terminalSince ??= Date.now();
        if (Date.now() - terminalSince < DELIVERY_GRACE_MS) return;

        selfDelivering = true;
        console.warn(
          `[pi:session:${semlaSessionId.slice(0, 8)}] workflow ${runId} is ${run.status} but pi delivered no result within ${DELIVERY_GRACE_MS / 1000}s — delivering it directly`,
        );
        void session
          .sendCustomMessage(
            {
              content: finishedRunMessage(run, runId),
              customType: "workflow-result",
              display: true,
            },
            { triggerTurn: true },
          )
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(
              `[pi:session:${semlaSessionId.slice(0, 8)}] direct delivery of ${runId} failed: ${msg}`,
            );
          });
      }, POLL_MS)
    : undefined;

  const TIMEOUT_MS = 30 * 60 * 1000;
  const superseded = new Promise<void>((_, reject) => {
    if (abortSignal.aborted) {
      reject(new Error("background continuation superseded by new prompt"));
      return;
    }
    abortSignal.addEventListener("abort", () =>
      reject(new Error("background continuation superseded by new prompt")),
    );
  });

  let supersededByNewPrompt = false;
  try {
    await Promise.race([
      deliveryStarted,
      superseded,
      new Promise<void>((_, reject) =>
        setTimeout(
          () => reject(new Error("background workflow delivery timed out")),
          TIMEOUT_MS,
        ),
      ),
    ]);
    await session.agent.waitForIdle();
    const entries = session.sessionManager.getEntries();
    log(semlaSessionId, "bg continuation complete", {
      entries: entries.length,
    });
    for (const entry of entries) {
      await persistEntry(piSessionId, entry as PiSessionEntry);
    }
    debug.onBgComplete(entries.length);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("superseded")) {
      supersededByNewPrompt = true;
      log(semlaSessionId, "bg continuation superseded — delivery will go to new session");
    } else {
      console.warn(
        `[pi:session:${semlaSessionId.slice(0, 8)}] bg continuation ended: ${msg}`,
      );
      if (msg.includes("timed out")) {
        debug.onBgTimeout();
      } else {
        debug.onError(msg);
      }
    }
  } finally {
    if (watchdog) clearInterval(watchdog);
    unsubscribeBg();
    bgAbortControllers.delete(semlaSessionId);
    detach(semlaSessionId, "clear running", setSessionRunning(semlaSessionId, false));
    stampWikiRepo(semlaSessionId, projects, continuationStartedAt);
    if (supersededByNewPrompt) {
      // A new prompt took over this session. Do NOT dispose — that would kill the
      // shared bash executor and abort the new session's in-flight tool calls.
      log(semlaSessionId, "bg session released (not disposed — new session active)");
    } else {
      log(semlaSessionId, "bg session disposed");
      if (runId) {
        // Disposes the session and drops it from the retained map, which would
        // otherwise keep a dead session (and its bash executor) referenced.
        releaseBackgroundSession(runId);
        await finalizeBackgroundRun(semlaSessionId, runId);
      } else {
        session.dispose();
      }
    }
  }
};
