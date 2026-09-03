/**
 * The lifecycle of one prompt turn: restore the session, load and verify
 * extensions, run the agent loop, persist what it produced, and decide what — if
 * anything — still needs watching once it ends.
 *
 * What the turn *does* in response to the agent's events lives in
 * session-event-router.ts; what happens after it ends lives in
 * background-continuation.ts. This file is the sequence.
 */

import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { mkdir } from "node:fs/promises";

import { registerNotifier } from "@/lib/pi/ask-user-bridge";
import { runBackgroundContinuation } from "@/lib/pi/background-continuation";
import {
  queueEntries,
  seedPersistedEntryIds,
} from "@/lib/pi/entry-persist-queue";
import { unfinishedBackgroundRunId } from "@/lib/pi/background-run-recovery";
import { releaseBackgroundSession } from "@/lib/pi/background-sessions";
import {
  abortBackgroundContinuation,
  armBackgroundContinuation,
  hasBackgroundContinuation,
} from "@/lib/pi/bg-continuation-registry";
import { followBridgeRunProgress } from "@/lib/pi/bridge-run-progress";
import {
  createSessionDebugWriter,
  type SessionPhase,
} from "@/lib/pi/debug-writer";
import {
  ACTIVE_WORKFLOW_MANAGER,
  BRIDGE_RUN_STARTED,
  clearSlot,
  readSlot,
  writeSlot,
  type BridgeRunNotifier,
} from "@/lib/pi/extension-contract";
import { recordExtensionLoad } from "@/lib/pi/extension-health";
import {
  assertExtensionLoad,
  assertExtensionPathsExist,
  assertManifestIsCoherent,
  buildExtensionLoadReport,
  EXTENSION_MANIFEST,
  extensionFactoriesInLoadOrder,
  extensionPathsInLoadOrder,
  manifestForSession,
} from "@/lib/pi/extension-manifest";
import {
  getLiveSession,
  releaseLiveSession,
  retainLiveSession,
} from "@/lib/pi/live-sessions";
import {
  PI_AGENT_DIR,
  PI_SESSION_DIR,
  PI_TOOLS,
  WORKFLOW_SKILLS_PATH,
  getPiRuntimeConfig,
} from "@/lib/pi/runtime-config";
import {
  applyBranchTarget,
  resolveBranchTarget,
} from "@/lib/pi/session-branch";
import { isProjectAnchored, resolveSessionCwd } from "@/lib/pi/session-cwd";
import { createTurnEventRouter } from "@/lib/pi/session-event-router";
import {
  releaseSpanSink,
  retainSpanSink,
} from "@/lib/pi/telemetry/sink-registry";
import { createSpanPublisher } from "@/lib/pi/telemetry/span-publisher";
import { AGENT_TELEMETRY_SCHEMAS } from "@mariozechner/pi-agent-core";

import {
  stampConversationUsage,
  sumEntryUsage,
} from "@/lib/pi/session-usage-store";
import { createHostTelemetry } from "@/lib/pi/telemetry/host-recorder";
import { SEMLA_TELEMETRY_SCHEMA } from "@/lib/pi/telemetry/schema";
import { sensitiveAttributeKeys } from "@/lib/pi/telemetry/span-sink";
import { appendSpans } from "@/lib/pi/telemetry/span-store";
import { createSpanSink } from "@/lib/pi/telemetry/span-sink";
import type { EmitSessionEvent, PiSessionEvent } from "@/lib/pi/session-events";
import { detach, sessionLog, sessionWarn } from "@/lib/pi/session-log";
import {
  createSessionFile,
  ensurePiSession,
  fetchPersistedEntries,
  fetchStuckBackgroundRuns,
  finalizeBackgroundRun,
  setSessionRunning,
  updateSessionTitle,
  type PiSessionEntry,
} from "@/lib/pi/session-persistence";
import {
  closeSessionStream,
  openSessionStream,
  publishToSessionStream,
} from "@/lib/pi/session-stream-store";
import { stampWikiRepo } from "@/lib/pi/session-wiki-stamp";
import { DEFAULT_SYSTEM_PROMPT } from "@/lib/pi/system-prompt";
import {
  createTurnBackgroundState,
  decideContinuation,
} from "@/lib/pi/turn-background-state";
import { clearSessionRepo, setSessionRepos } from "@/lib/pi/wiki-session-repo";
import { finishedRunMessage } from "@/lib/pi/workflow-delivery-message";
import { isRunTerminal, readWorkflowRun } from "@/lib/pi/workflow-run-reader";

/**
 * Trailing debounce for span flushes. Long enough that a fan-out of ten agents
 * is one frame, short enough that the panel does not visibly lag the run.
 */
const SPAN_FLUSH_MS = 250;

/**
 * Every attribute any schema in play marks sensitive — ours and pi's.
 *
 * Built from the schemas rather than listed, so pi marking a new attribute
 * sensitive in a release is respected without a change here. Computed once:
 * it is static for the process.
 */
const SENSITIVE_SPAN_ATTRIBUTES = sensitiveAttributeKeys([
  SEMLA_TELEMETRY_SCHEMA,
  ...AGENT_TELEMETRY_SCHEMAS,
]);

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

/**
 * Is a turn actually in flight for this session?
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
  hasBackgroundContinuation(semlaSessionId);

/**
 * Interrupt a session's current turn.
 *
 * Aborts the agent loop and any background continuation waiting on it, then
 * clears the running flag so the UI stops showing a spinner for work that has
 * ended. Reports whether there was anything to stop, so the caller can tell
 * "stopped it" from "it had already finished".
 */
export const stopPiSession = async (semlaSessionId: string): Promise<boolean> => {
  const live = getLiveSession(semlaSessionId);
  const watching = hasBackgroundContinuation(semlaSessionId);

  if (!live && !watching) return false;

  sessionLog(semlaSessionId, "stop requested");
  abortBackgroundContinuation(semlaSessionId);

  try {
    await live?.abort();
  } catch (error) {
    // An abort that fails still leaves the turn no longer wanted; the finally
    // in runPiPrompt is what actually tears the session down.
    const message = error instanceof Error ? error.message : String(error);
    sessionWarn(semlaSessionId, `abort failed: ${message}`);
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

  const emit: EmitSessionEvent = (event) => {
    publishToSessionStream(semlaSessionId, event);
    onEvent(event);
  };

  // Buffer the user's prompt as the first event so reconnecting clients can
  // show it optimistically before entries are persisted at end of turn.
  emit({ text, type: "user-message" });

  // If there's a background continuation waiting for a delivery that will now
  // go to this new session (pi-dynamic-workflows re-targets delivery to the
  // latest loaded session), abort it so it exits without disposing.
  abortBackgroundContinuation(semlaSessionId);

  const debug = createSessionDebugWriter(semlaSessionId);

  sessionLog(semlaSessionId, "prompt start", {
    model: `${model.provider}/${model.modelId}`,
    tools: tools.join(","),
  });
  debug.onPromptStart(text, `${model.provider}/${model.modelId}`, tools);

  /**
   * Close off a phase and record how long it took.
   *
   * Everything from here to the first persisted entry was previously one
   * unrecorded window, so a stalled provider request and a slow extension
   * compile left identical artifacts. See SessionPhase.
   */
  let phaseMark = Date.now();
  const phase = (name: SessionPhase) => {
    const now = Date.now();
    debug.onPhase(name, now - phaseMark);
    phaseMark = now;
  };

  const configuredModel = await getConfiguredModel(model);
  phase("model-resolved");
  const piSession = await ensurePiSession(semlaSessionId, configuredModel);
  const persistedEntries = await fetchPersistedEntries(piSession.id);
  // What the mirror already holds, so the turn only writes what it adds.
  seedPersistedEntryIds(
    piSession.id,
    persistedEntries.map((entry) => entry.id),
  );

  sessionLog(semlaSessionId, "session restored", {
    entries: persistedEntries.length,
  });
  debug.onSessionRestored(persistedEntries.length);

  /**
   * The agent runs in the session's anchor project, not the workspace root
   * above all of them — see session-cwd.ts for what that cost. Resolved once
   * and passed to every seam that takes a cwd, because they must agree: the
   * resource loader, the agent session, and the session manager's override all
   * feed the `ctx.cwd` extensions read on session_start.
   */
  const agentCwd = resolveSessionCwd(projects);
  const projectAnchored = isProjectAnchored(agentCwd);

  /**
   * A session with no project loads a smaller extension set: see
   * `requiresProjectAnchor`. It picks the rest up on the next turn after a
   * project appears, including one the agent attached itself by writing a file.
   */
  const specs = manifestForSession({ projectAnchored });

  if (projectAnchored) {
    sessionLog(semlaSessionId, "agent cwd", { cwd: agentCwd });
  } else {
    sessionLog(semlaSessionId, "no project anchor — project-scoped extensions skipped", {
      skipped: EXTENSION_MANIFEST.filter((spec) => spec.requiresProjectAnchor)
        .map((spec) => spec.id)
        .join(","),
    });
  }

  const sessionFile = await createSessionFile(semlaSessionId, persistedEntries);
  // Third argument is pi's cwdOverride, which supersedes the session header's
  // recorded cwd — so an existing session file written against the workspace
  // root still runs in the right place.
  const sessionManager = SessionManager.open(sessionFile, PI_SESSION_DIR, agentCwd);
  phase("session-loaded");

  // Before anything is appended: move the leaf so this turn lands where the
  // edited prompt was, rather than after the answer it is replacing.
  if (editEntryId) {
    applyBranchTarget(
      sessionManager,
      resolveBranchTarget(sessionManager.getEntries(), editEntryId),
    );
    sessionLog(semlaSessionId, "editing entry", { entry: editEntryId });
  }

  // Publish this session's repo so the wiki bridge can attribute the sources its
  // subagents capture. The key must be the *pi runtime* session id, which is
  // what the bridge reads from ctx.sessionManager on session_start — not
  // piSession.id, which is a Supabase pi_sessions row id. Keying it on the row
  // id made every lookup miss, so entity namespacing and capture-time
  // attribution silently did nothing while the turn-end sweep covered for them.
  const piRuntimeSessionId = sessionManager.getSessionId();

  // The projects this turn has already linked. Declared before turnRepoSlugs,
  // which reads it: the other way round, every prompt threw on the temporal
  // dead zone — "Cannot access 'attachedThisTurn' before initialization".
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

  /**
   * Span sink for this turn, published before bindExtensions so the workflow
   * extension can find it on session_start.
   *
   * Nothing reads the spans yet — transport and rendering are the next steps of
   * docs/plans/agent-telemetry.md. The count is logged at turn end so that a
   * real run can be checked to be producing them at all.
   */
  const spanPublisher = createSpanPublisher();

  /**
   * Send the client the spans it has not seen.
   *
   * Debounced on a trailing edge because a fan-out opens many spans in one
   * tick, and each would otherwise be its own SSE frame. Flushed once more at
   * turn end so the last closes are not left behind by the timer.
   */
  let spanFlush: ReturnType<typeof setTimeout> | undefined;
  /**
   * One batch, two destinations: the stream for this page, and the file for
   * the next one. Both want the same delta, and computing it once is what
   * keeps them from disagreeing about what has been seen.
   */
  const flushSpans = async () => {
    const pending = spanPublisher.pending(spanSink.spans());
    if (pending.length === 0) return;
    emit({ spans: pending, type: "spans" });
    await appendSpans(semlaSessionId, pending);
  };
  const scheduleSpanFlush = () => {
    if (spanFlush) return;
    spanFlush = setTimeout(() => {
      spanFlush = undefined;
      // Not awaited: this is a timer, and `appendSpans` never rejects.
      void flushSpans();
    }, SPAN_FLUSH_MS);
  };

  const spanSink = createSpanSink(semlaSessionId, {
    onChange: scheduleSpanFlush,
    // Kept, per §8.1 — a persisted trace contains the prompt excerpt and a
    // subagent's prompt. Passed anyway so the switch is real: redaction finds
    // an attribute by looking it up in the schemas, and a key set that was
    // never built would make `sensitive: "drop"` silently redact nothing.
    sensitive: "keep",
    sensitiveKeys: SENSITIVE_SPAN_ATTRIBUTES,
  });
  /**
   * The turn's own spans, opened before extensions load.
   *
   * The order matters: the workflow extension reads the turn span id on
   * `session_start`, which pi fires from inside `createAgentSession` below, so
   * a turn span opened after that would leave every workflow run rooted
   * instead of nested (plan §8.4).
   */
  const host = createHostTelemetry(spanSink, {
    piSessionId: piRuntimeSessionId,
  });
  host.turnStarted({ text });
  retainSpanSink(piRuntimeSessionId, spanSink, host);
  await mkdir(PI_AGENT_DIR, { recursive: true });
  const unregisterNotifier = registerNotifier(semlaSessionId, (payload) => {
    emit({ payload, type: "ask-user-question" });
  });

  // Validate before Pi ever sees the paths: a missing entry file or an
  // inconsistent manifest fails here with a fix attached, rather than becoming
  // a session that quietly runs without the tools it was supposed to have.
  assertManifestIsCoherent(specs);
  assertExtensionPathsExist(specs);

  const resourceLoader = new DefaultResourceLoader({
    // Paths first, then factories — that is the order Pi loads them in, and the
    // manifest relies on it: wiki-ingest-bridge is a factory that requires the
    // path-loaded wiki extension. assertManifestIsCoherent enforces it.
    additionalExtensionPaths: extensionPathsInLoadOrder(specs),
    extensionFactories: extensionFactoriesInLoadOrder(specs),
    additionalSkillPaths: [WORKFLOW_SKILLS_PATH],
    agentDir: PI_AGENT_DIR,
    cwd: agentCwd,
    appendSystemPrompt: [systemPrompt ?? DEFAULT_SYSTEM_PROMPT],
  });
  await resourceLoader.reload();
  phase("extensions-compiled");

  const { extensionsResult, session } = await createAgentSession({
    cwd: agentCwd,
    model: configuredModel.model,
    modelRuntime: configuredModel.runtime,
    resourceLoader,
    sessionManager,
  });
  phase("agent-created");

  // Registered before the turn starts so a stop request has something to reach.
  retainLiveSession(semlaSessionId, session);

  const loadedExtensions = extensionsResult.extensions.map((e) => e.path);
  sessionLog(semlaSessionId, "extensions loaded", {
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
      sessionWarn(
        semlaSessionId,
        `extension error (${err.extensionPath}): ${err.error}`,
      ),
  });

  // Extension tools register during bindExtensions, and contract slots are
  // published from session_start handlers that Pi fires from the same call, so
  // this is the first moment the whole extension set can be checked against
  // what the manifest declared. Previously only a missing `workflow` tool was
  // fatal — every other extension could fail to load and the session would run
  // on silently without its tools.
  phase("extensions-bound");

  const boundTools = session.getActiveToolNames();
  const extensionReport = buildExtensionLoadReport({
    loadedPaths: loadedExtensions,
    loadErrors: extensionsResult.errors,
    registeredTools: boundTools,
    specs,
  });

  // Publish before any throw, so a failed load is visible at /api/pi/health
  // rather than only in this process's logs.
  recordExtensionLoad(extensionReport);

  if (extensionReport.unexpectedErrors.length > 0) {
    // Not from the manifest — most likely a project-scope package configured in
    // the workspace's own .pi/settings.json. Worth seeing, not worth refusing
    // the session over.
    sessionWarn(
      semlaSessionId,
      `non-manifest extension errors:\n${extensionReport.unexpectedErrors.join("\n")}`,
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
  sessionLog(semlaSessionId, "active tools", { tools: activeTools.join(",") });

  // Recover background workflows whose delivery was lost (e.g. server restart mid-run).
  // Inject the result as a context message so Pi sees the completed workflow in this prompt.
  const stuckRuns = await fetchStuckBackgroundRuns(semlaSessionId);
  for (const { run_id } of stuckRuns) {
    const runState = readWorkflowRun(agentCwd, run_id);
    if (!runState || runState.status !== "completed") continue;
    try {
      await session.sendCustomMessage(
        {
          content: finishedRunMessage(runState, run_id, agentCwd),
          customType: "workflow-result",
          display: true,
        },
        { triggerTurn: false },
      );
      detach(semlaSessionId, "finalize run", finalizeBackgroundRun(semlaSessionId, run_id));
      sessionLog(semlaSessionId, "recovered stuck bg run", { run: run_id });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sessionWarn(semlaSessionId, `bg run recovery failed for ${run_id}: ${msg}`);
    }
  }
  phase("stuck-runs-checked");

  // What this turn learns about background work as it streams, and what the
  // `finally` below reads to decide whether anything still needs watching.
  const state = createTurnBackgroundState();

  const router = createTurnEventRouter({
    agentCwd,
    attachedThisTurn,
    debug,
    emit,
    host,
    piRuntimeSessionId,
    semlaSessionId,
    session,
    state,
    turnRepoSlugs,
  });

  // Register per-turn notifier for bridge-dispatched background runs (e.g. from
  // wiki-ingest-bridge). These run via manager.startInBackground() directly and
  // never emit a `workflow` tool event, so they must notify via globalThis.
  // Primary runs (e.g. wiki-ingest batch coordinators) arm the background
  // continuation so the agent is notified once when the batch completes.
  const bridgeRunNotifier: BridgeRunNotifier = (runId, opts = {}) => {
    sessionLog(semlaSessionId, "bridge background run started", { run: runId });
    router.announceBackgroundRun(runId);

    followBridgeRunProgress(
      readSlot(ACTIVE_WORKFLOW_MANAGER),
      runId,
      (snapshot) => router.persistBridgeSnapshot(snapshot, runId),
    );

    if (opts.primary) router.claimBridgeRun(runId);
  };
  writeSlot(BRIDGE_RUN_STARTED, bridgeRunNotifier);

  // Subscribed after the stuck-run recovery above, so the messages it injects
  // cannot be mistaken for this turn's delivery.
  const unsubscribe = session.subscribe(router.onSessionEvent);
  /**
   * Why the turn ended, for the run span's outcome. `pi.harness.turn` declares
   * no end attributes, which is why there is a run span above it at all.
   */
  let turnFailure: { code?: string; type?: string } | null = null;

  try {
    sessionLog(semlaSessionId, "prompting");
    debug.onModelRequestStart();
    await session.prompt(text);
    await session.agent.waitForIdle();
    phase("model-turn");
    const entries = session.sessionManager.getEntries();
    sessionLog(semlaSessionId, "prompt complete", {
      entries: entries.length,
      background: state.hasBackgroundWorkflow,
    });
    // Queued, not awaited: the answer has already streamed, and the session
    // file — which is what getTranscript reads — is already written. Waiting
    // here kept the client spinning through a write the UI never reads.
    const queued = queueEntries(
      piSession.id,
      semlaSessionId,
      entries as PiSessionEntry[],
    );
    debug.onEntriesQueued(queued, entries.length);
    // Disk is what the badges read, and these entries are already in memory —
    // cumulative for the session, so a set rather than an add.
    stampConversationUsage(semlaSessionId, sumEntryUsage(entries));
    debug.onPromptComplete(entries.length, state.hasBackgroundWorkflow);
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
    // Recorded on the way out too: how long a turn ran before it failed is the
    // more interesting number, and a provider timeout arrives as a throw.
    phase("model-turn");
    debug.onError(msg);
    turnFailure = {
      code: msg.slice(0, 200),
      type: err instanceof Error ? err.name : "Error",
    };
    throw new Error(msg);
  } finally {
    unsubscribe();
    unregisterNotifier();
    releaseLiveSession(semlaSessionId);
    clearSessionRepo(piRuntimeSessionId);
    // The recorder the manager holds closes over the sink, so a background run
    // keeps recording after this; only the lookup goes away.
    releaseSpanSink(piRuntimeSessionId);

    /**
     * Decided here rather than below, because the turn span's fate depends on
     * it and the final flush has to happen before `closeSessionStream` — after
     * that, emitted spans reach nobody. Only the *decision* moves; the branch
     * that acts on it is unchanged, further down.
     */
    const decision = decideContinuation({
      findUnfinishedRun: () =>
        unfinishedBackgroundRunId(semlaSessionId, agentCwd),
      isRunTerminal: (runId) =>
        isRunTerminal(readWorkflowRun(agentCwd, runId)),
      state,
    });

    // A watched turn's span outlives this function: the workflow it parents is
    // still running, and closing it here would draw a six-minute run hanging
    // off a turn that ended in seconds (§8.4). The continuation closes it.
    if (decision.kind !== "watch") {
      host.turnEnded(turnFailure ? "failed" : "completed", turnFailure ?? undefined);
    }

    // The timer may hold spans that closed in the last few milliseconds, and
    // the stream is about to shut. Cancel it and send them synchronously.
    if (spanFlush) clearTimeout(spanFlush);
    spanFlush = undefined;
    // Awaited, unlike the timer: after this the turn is over, and a
    // fire-and-forget write here is a trace that loses its last spans.
    await flushSpans();
    if (spanSink.counts.recorded > 0) {
      sessionLog(semlaSessionId, "spans recorded", {
        open: spanSink.counts.open,
        recorded: spanSink.counts.recorded,
        trace: spanSink.traceId,
      });
    }
    // Clear the bridge run notifier so a stale reference can't fire after turn end.
    clearSlot(BRIDGE_RUN_STARTED);
    closeSessionStream(semlaSessionId);
    stampWikiRepo(semlaSessionId, turnRepoSlugs(), turnStartedAt);

    if (decision.kind === "settled") {
      // The workflow outran the prompt turn: its result is already delivered
      // and persisted above, so there is no continuation to wait for.
      sessionLog(semlaSessionId, "background workflow settled during prompt turn");
      if (decision.runId) {
        detach(
          semlaSessionId,
          "finalize run",
          finalizeBackgroundRun(semlaSessionId, decision.runId),
        );
        releaseBackgroundSession(decision.runId);
      } else {
        session.dispose();
      }
      detach(semlaSessionId, "clear running", setSessionRunning(semlaSessionId, false));
    } else if (decision.kind === "watch") {
      // Keep the session alive to receive background workflow progress and the
      // final report turn that pi delivers when the workflow completes.
      // is_running stays true until runBackgroundContinuation clears it.
      if (decision.rearmed) {
        sessionLog(semlaSessionId, "re-arming continuation for an earlier run", {
          run: decision.runId,
        });
        detach(semlaSessionId, "set running", setSessionRunning(semlaSessionId, true));
      }

      void runBackgroundContinuation({
        abortSignal: armBackgroundContinuation(semlaSessionId),
        agentCwd,
        debug,
        piSessionId: piSession.id,
        projects,
        runId: decision.runId,
        semlaSessionId,
        session,
        spans: {
          endTurn: (outcome) => host.turnEnded(outcome),
          // The same flush. Its `emit` is a no-op once the stream is closed,
          // but the append is not — which is how a background run's spans
          // reach the file the next page load reads.
          flush: flushSpans,
        },
      });
    } else {
      sessionLog(semlaSessionId, "session disposed");
      session.dispose();
      detach(semlaSessionId, "clear running", setSessionRunning(semlaSessionId, false));
    }
  }
};
