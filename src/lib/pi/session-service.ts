import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

import { retainBackgroundSession } from "@/lib/pi/background-sessions";
import { DEFAULT_SYSTEM_PROMPT } from "@/lib/pi/prompts";
import {
  createSessionDebugWriter,
  type SessionDebugWriter,
} from "@/lib/pi/debug-writer";
import {
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
import { readWorkflowRun } from "@/lib/pi/workflow-run-reader";
import type { WorkflowSnapshot } from "@/types/workflow";

const workflowExtensionPath = join(
  process.cwd(),
  "node_modules/@quintinshaw/pi-dynamic-workflows/extensions/workflow.ts",
);

const workflowProgressBridgePath = join(
  process.cwd(),
  "src/lib/pi/extensions/workflow-progress-bridge.ts",
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

  return details as WorkflowSnapshot;
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
  const resourceLoader = new DefaultResourceLoader({
    additionalExtensionPaths: [workflowExtensionPath, workflowProgressBridgePath],
    agentDir: getAgentDir(),
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
    const done = runState.agents.filter((a) => a.status === "done").length;
    const total = runState.agents.length;
    const content =
      `✓ Background workflow "${runState.workflowName}" finished (${done}/${total} agents). ` +
      `The result is available at ~/.pi/workflows/projects/*/runs/${run_id}.json`;
    try {
      await session.sendCustomMessage(
        { customType: "workflow-result", content, display: true },
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
  const unsubscribe = session.subscribe((event) => {
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
      await updateSessionTitle(semlaSessionId, title);
      onEvent({ title, type: "title-updated" });
    }
    onEvent({ type: "complete" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    debug.onError(msg);
    throw new Error(msg);
  } finally {
    unsubscribe();
    if (hasBackgroundWorkflow) {
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

    // The delivery turn starts with a message_update once pi processes the result.
    if (e.type === "message_update") {
      if (resolveDelivery) {
        log(semlaSessionId, "bg delivery detected · report turn starting");
        debug.onBgDelivery();
        resolveDelivery();
        resolveDelivery = undefined;
      }
      const update = (e.assistantMessageEvent ?? {}) as Record<string, unknown>;
      if (update.type === "text_delta" && typeof update.delta === "string") {
        debug.onAssistantDelta(update.delta);
      }
    }
  });

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
    unsubscribeBg();
    bgAbortControllers.delete(semlaSessionId);
    if (supersededByNewPrompt) {
      // A new prompt took over this session. Do NOT dispose — that would kill the
      // shared bash executor and abort the new session's in-flight tool calls.
      log(semlaSessionId, "bg session released (not disposed — new session active)");
    } else {
      log(semlaSessionId, "bg session disposed");
      session.dispose();
      if (runId) {
        await finalizeBackgroundRun(runId);
      }
    }
  }
};
