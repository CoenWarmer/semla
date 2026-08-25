import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  releaseBackgroundSession,
  retainBackgroundSession,
} from "@/lib/pi/background-sessions";
import { registerNotifier, type AskUserPayload } from "@/lib/pi/ask-user-bridge";
import { DEFAULT_SYSTEM_PROMPT } from "@/lib/pi/prompts";
import {
  createSessionDebugWriter,
  type SessionDebugWriter,
} from "@/lib/pi/debug-writer";
import {
  PI_AGENT_DIR,
  PI_SESSION_DIR,
  PI_WORKSPACE_ROOT,
  getPiRuntimeConfig,
} from "@/lib/pi/runtime-config";
import {
  createSessionFile,
  ensurePiSession,
  fetchPersistedEntries,
  fetchStuckBackgroundRuns,
  finalizeBackgroundRun,
  persistBackgroundWorkflowStart,
  persistEntry,
  persistWorkflowSnapshot,
  updateSessionTitle,
} from "@/lib/pi/session-persistence";
import {
  readWorkflowRun,
  workflowRunPath,
  type PersistedRunState,
} from "@/lib/pi/workflow-run-reader";
import { historyToTurns } from "@/lib/pi/workflow-snapshot-merge";
import type { WorkflowSnapshot } from "@/types/workflow";

const workflowExtensionPath = join(
  process.cwd(),
  "src/lib/pi/extensions/workflow.ts",
);

const askUserExtensionPath = join(
  process.cwd(),
  "src/lib/pi/extensions/ask-user.ts",
);

const workflowSkillsPath = join(
  process.cwd(),
  "src/lib/pi/extensions/dynamic-workflows/skills",
);

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
  | { delta: string; type: "assistant-delta" }
  | { toolName: string; type: "tool-start" }
  | { toolName: string; type: "tool-end" }
  | { runId: string; type: "workflow-started" }
  | { snapshot: WorkflowSnapshot; type: "workflow-snapshot" }
  | { payload: AskUserPayload; type: "ask-user-question" }
  | { message: string; type: "error" }
  | { title: string; type: "title-updated" }
  | { type: "complete" };

const asWorkflowSnapshot = (value: unknown): WorkflowSnapshot | undefined => {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const details = "details" in value ? value.details : undefined;
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

// Run states after which no further agent work happens, so a result that has
// not been delivered yet never will be without intervention.
const TERMINAL_RUN_STATUSES = new Set(["aborted", "completed", "failed"]);

const isRunTerminal = (
  run: PersistedRunState | null,
): run is PersistedRunState =>
  run !== null && TERMINAL_RUN_STATUSES.has(run.status);

const RESULT_SUMMARY_MAX_CHARS = 2000;

// Mirrors summarizeResult() in pi-dynamic-workflows' task-panel: prefer a
// human-readable field, else a capped JSON dump. The full result stays on disk.
const summarizeRunResult = (result: unknown): string => {
  if (typeof result === "string") return result;

  if (result && typeof result === "object") {
    for (const key of ["verdict", "report", "summary", "synthesis"]) {
      const value = (result as Record<string, unknown>)[key];
      if (typeof value === "string" && value.trim()) return value;
    }
  }

  const json = JSON.stringify(result ?? null, null, 2);
  return json.length <= RESULT_SUMMARY_MAX_CHARS
    ? json
    : `${json.slice(0, RESULT_SUMMARY_MAX_CHARS)}\n…(truncated — read the full result from the path below)`;
};

// The message pi-dynamic-workflows would have delivered for a finished run.
// Used by both recovery paths: the in-continuation watchdog and the
// next-prompt catch-up.
const finishedRunMessage = (run: PersistedRunState, runId: string): string => {
  const done = run.agents.filter((agent) => agent.status === "done").length;
  return [
    `✓ Background workflow "${run.workflowName}" finished (${done}/${run.agents.length} agents).`,
    "",
    summarizeRunResult(run.result),
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

export const runPiPrompt = async ({
  model,
  onEvent,
  semlaSessionId,
  systemPrompt,
  text,
  tools,
}: {
  model: { modelId: string; provider: string };
  onEvent: (event: PiSessionEvent) => void;
  semlaSessionId: string;
  systemPrompt?: string | null;
  text: string;
  tools: string[];
}) => {
  assertSandboxedRuntime();

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
  await mkdir(PI_AGENT_DIR, { recursive: true });
  const unregisterNotifier = registerNotifier(semlaSessionId, (payload) => {
    onEvent({ payload, type: "ask-user-question" });
  });

  const resourceLoader = new DefaultResourceLoader({
    additionalExtensionPaths: [workflowExtensionPath, askUserExtensionPath],
    // The workflow skills ship inside the package but are only contributed when
    // it is loaded as a package. We load the extension file directly, so point
    // at this repo's copy explicitly rather than inheriting them from whatever
    // is installed in the developer's agent dir.
    additionalSkillPaths: [workflowSkillsPath],
    agentDir: PI_AGENT_DIR,
    cwd: PI_WORKSPACE_ROOT,
    appendSystemPrompt: [systemPrompt ?? DEFAULT_SYSTEM_PROMPT],
  });
  await resourceLoader.reload();
  const { extensionsResult, session } = await createAgentSession({
    cwd: PI_WORKSPACE_ROOT,
    model: configuredModel.model,
    modelRuntime: configuredModel.runtime,
    resourceLoader,
    sessionManager,
  });

  const loadedExtensions = extensionsResult.extensions.map((e) => e.path);
  const extensionErrors = extensionsResult.errors.map(
    (e) => `${e.path}: ${e.error}`,
  );
  log(semlaSessionId, "extensions loaded", {
    loaded: loadedExtensions.length,
    errors: extensionErrors.length,
  });
  if (extensionErrors.length > 0) {
    console.warn(
      `[pi:session:${semlaSessionId.slice(0, 8)}] extension errors:\n${extensionErrors.join("\n")}`,
    );
  }

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

  session.setActiveToolsByName(tools);
  const activeTools = session.getActiveToolNames();
  log(semlaSessionId, "active tools", { tools: activeTools.join(",") });

  if (tools.includes("workflow") && !activeTools.includes("workflow")) {
    session.dispose();
    throw new Error(
      extensionErrors.length > 0
        ? `Pi workflow extension failed to load.\n${extensionErrors.join("\n")}`
        : "Pi workflow extension did not register its workflow tool.",
    );
  }

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
      void finalizeBackgroundRun(run_id);
      log(semlaSessionId, "recovered stuck bg run", { run: run_id });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[pi:session:${semlaSessionId.slice(0, 8)}] bg run recovery failed for ${run_id}: ${msg}`,
      );
    }
  }

  let hasBackgroundWorkflow = false;
  let detectedBackgroundRunId: string | undefined;
  // A short background workflow can finish while the prompt turn is still
  // streaming. Pi then delivers the result as a follow-up inside this same
  // prompt() call, so there is nothing left for the background continuation to
  // wait for. Subscribed after the stuck-run recovery above, so the messages it
  // injects cannot be mistaken for this turn's delivery.
  let deliveredDuringPrompt = false;
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
        onEvent({ delta: update.delta, type: "assistant-delta" });
      }
    }

    if (event.type === "tool_execution_start") {
      log(semlaSessionId, "tool start", { tool: event.toolName });
      debug.onToolStart(event.toolName);
      onEvent({ toolName: event.toolName, type: "tool-start" });
    }

    if (event.type === "tool_execution_end") {
      log(semlaSessionId, "tool end", { tool: event.toolName });
      debug.onToolEnd(event.toolName, event.result);
      onEvent({ toolName: event.toolName, type: "tool-end" });

      if (event.toolName === "workflow") {
        const backgroundRunId = getBackgroundWorkflowRunId(event.result);
        if (backgroundRunId) {
          hasBackgroundWorkflow = true;
          detectedBackgroundRunId = backgroundRunId;
          log(semlaSessionId, "workflow background detected", {
            run: backgroundRunId,
          });
          retainBackgroundSession(backgroundRunId, session);
          void persistBackgroundWorkflowStart(semlaSessionId, backgroundRunId);
          onEvent({ runId: backgroundRunId, type: "workflow-started" });
        }

        const snapshot = asWorkflowSnapshot(event.result);
        if (snapshot) {
          const enriched = withRunId(snapshot, backgroundRunId);
          debug.onWorkflowSnapshot(enriched, "foreground");
          void persistWorkflowSnapshot(semlaSessionId, enriched, "foreground");
          onEvent({ snapshot: enriched, type: "workflow-snapshot" });
        }
      }
    }

    if (
      event.type === "tool_execution_update" &&
      event.toolName === "workflow"
    ) {
      const snapshot = asWorkflowSnapshot(event.partialResult);
      if (snapshot) {
        const enriched = withRunId(snapshot, detectedBackgroundRunId);
        debug.onWorkflowSnapshot(enriched, "foreground");
        void persistWorkflowSnapshot(semlaSessionId, enriched, "foreground");
        onEvent({ snapshot: enriched, type: "workflow-snapshot" });
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
    for (const entry of entries) {
      await persistEntry(piSession.id, entry as PiSessionEntry);
    }
    debug.onPromptComplete(entries.length, hasBackgroundWorkflow);
    if (persistedEntries.length === 0) {
      const title = generateTitle(text);
      // Fire-and-forget: a slow or failing Supabase write must not block the
      // SSE stream from closing, which would leave the client stuck pending.
      void updateSessionTitle(semlaSessionId, title);
      onEvent({ title, type: "title-updated" });
    }
    onEvent({ type: "complete" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    debug.onError(msg);
    throw new Error(msg);
  } finally {
    unsubscribe();
    unregisterNotifier();
    const settledDuringPrompt =
      deliveredDuringPrompt &&
      (!detectedBackgroundRunId ||
        isRunTerminal(readWorkflowRun(PI_WORKSPACE_ROOT, detectedBackgroundRunId)));

    if (hasBackgroundWorkflow && settledDuringPrompt) {
      // The workflow outran the prompt turn: its result is already delivered
      // and persisted above, so there is no continuation to wait for.
      log(semlaSessionId, "background workflow settled during prompt turn");
      if (detectedBackgroundRunId) {
        void finalizeBackgroundRun(detectedBackgroundRunId);
        releaseBackgroundSession(detectedBackgroundRunId);
      } else {
        session.dispose();
      }
    } else if (hasBackgroundWorkflow) {
      // Keep the session alive to receive background workflow progress and the
      // final report turn that pi delivers when the workflow completes.
      const bgAbort = new AbortController();
      bgAbortControllers.set(semlaSessionId, bgAbort);
      void runBackgroundContinuation(
        piSession.id,
        semlaSessionId,
        session,
        debug,
        detectedBackgroundRunId,
        bgAbort.signal,
      );
    } else {
      log(semlaSessionId, "session disposed");
      session.dispose();
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
) => {
  log(semlaSessionId, "bg continuation started");
  debug.onBgStart();

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
        const enriched = withRunId(snapshot, runId);
        debug.onWorkflowSnapshot(enriched, "background");
        void persistWorkflowSnapshot(semlaSessionId, enriched, "background");
      }
    }

    if (e.type === "tool_execution_end" && e.toolName === "workflow") {
      const snapshot = asWorkflowSnapshot(e.result);
      if (snapshot) {
        const enriched = withRunId(snapshot, runId);
        debug.onWorkflowSnapshot(enriched, "background");
        void persistWorkflowSnapshot(semlaSessionId, enriched, "background");
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
        await finalizeBackgroundRun(runId);
      } else {
        session.dispose();
      }
    }
  }
};
