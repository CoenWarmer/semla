/**
 * Watches a background workflow after the prompt turn that started it has
 * ended, so its result still reaches the conversation.
 *
 * Pi owns delivery: the workflow extension sends the result back and triggers a
 * report turn. This keeps the session alive long enough for that to happen,
 * persists the progress snapshots that arrive meanwhile, and — if delivery
 * never comes — delivers the finished run itself rather than leaving the
 * conversation frozen with a completed result sitting on disk.
 *
 * Split out of runPiPrompt, which armed it from its own `finally` block.
 */

import { releaseBackgroundSession } from "@/lib/pi/background-sessions";
import { releaseBackgroundContinuation } from "@/lib/pi/bg-continuation-registry";
import type { SessionDebugWriter } from "@/lib/pi/debug-writer";
import { asWorkflowSnapshot, liveSnapshot } from "@/lib/pi/session-events";
import { detach, sessionLog, sessionWarn } from "@/lib/pi/session-log";
import {
  finalizeBackgroundRun,
  persistEntry,
  persistWorkflowSnapshot,
  setSessionRunning,
  type PiSessionEntry,
} from "@/lib/pi/session-persistence";
import { stampWikiRepo } from "@/lib/pi/session-wiki-stamp";
import { finishedRunMessage } from "@/lib/pi/workflow-delivery-message";
import { isRunTerminal, readWorkflowRun } from "@/lib/pi/workflow-run-reader";

/** Poll interval for the delivery watchdog. */
const POLL_MS = 5 * 1000;
/** How long a run may sit terminal with no report turn before we deliver it. */
const DELIVERY_GRACE_MS = 15 * 1000;
/** Absolute ceiling on how long a continuation will wait for delivery. */
const TIMEOUT_MS = 30 * 60 * 1000;

const SUPERSEDED = "background continuation superseded by new prompt";

/**
 * The slice of a pi session a continuation uses. Structural rather than the
 * SDK's `AgentSession` so a test can stand one up.
 */
export type ContinuableSession = {
  agent: { waitForIdle: () => Promise<void> };
  dispose: () => void;
  sendCustomMessage: (
    message: { content: string; customType: string; display: boolean },
    options: { triggerTurn: boolean },
  ) => Promise<void>;
  sessionManager: { getEntries: () => unknown[] };
  subscribe: (callback: (event: unknown) => void) => () => void;
};

export const runBackgroundContinuation = async ({
  abortSignal,
  agentCwd,
  debug,
  piSessionId,
  projects,
  runId,
  semlaSessionId,
  session,
}: {
  abortSignal: AbortSignal;
  /** Where the turn's agent ran; run files are keyed by it. See session-cwd.ts. */
  agentCwd: string;
  debug: SessionDebugWriter;
  piSessionId: string;
  projects: readonly string[];
  /** The run being watched, when this turn could identify one. */
  runId: string | undefined;
  semlaSessionId: string;
  session: ContinuableSession;
}) => {
  sessionLog(semlaSessionId, "bg continuation started");
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
    sessionLog(semlaSessionId, "bg delivery detected · report turn starting", {
      via,
    });
    debug.onBgDelivery();
    resolveDelivery();
    resolveDelivery = undefined;
  };

  const persistSnapshot = (value: unknown) => {
    const snapshot = asWorkflowSnapshot(value);
    if (!snapshot) return;
    const enriched = liveSnapshot(snapshot, runId);
    debug.onWorkflowSnapshot(enriched, "background");
    detach(
      semlaSessionId,
      "persist snapshot",
      persistWorkflowSnapshot(semlaSessionId, enriched, "background"),
    );
  };

  const unsubscribeBg = session.subscribe((event: unknown) => {
    const e = event as Record<string, unknown>;

    if (e.type === "tool_execution_update" && e.toolName === "workflow") {
      persistSnapshot(e.partialResult);
    }

    if (e.type === "tool_execution_end" && e.toolName === "workflow") {
      persistSnapshot(e.result);
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

  // Watchdog. Pi owns delivery, but if that ever fails — delivery suspended,
  // extension error, version skew — the conversation would sit frozen until
  // TIMEOUT_MS with a finished result on disk. Poll the run file and deliver it
  // ourselves once it has been terminal for a grace period without a report turn.
  let selfDelivering = false;
  let terminalSince: number | undefined;
  const watchdog = runId
    ? setInterval(() => {
        if (selfDelivering || !resolveDelivery) return;

        const run = readWorkflowRun(agentCwd, runId);
        if (!isRunTerminal(run)) {
          terminalSince = undefined;
          return;
        }

        terminalSince ??= Date.now();
        if (Date.now() - terminalSince < DELIVERY_GRACE_MS) return;

        selfDelivering = true;
        sessionWarn(
          semlaSessionId,
          `workflow ${runId} is ${run.status} but pi delivered no result within ${DELIVERY_GRACE_MS / 1000}s — delivering it directly`,
        );
        void session
          .sendCustomMessage(
            {
              content: finishedRunMessage(run, runId, agentCwd),
              customType: "workflow-result",
              display: true,
            },
            { triggerTurn: true },
          )
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            sessionWarn(
              semlaSessionId,
              `direct delivery of ${runId} failed: ${msg}`,
            );
          });
      }, POLL_MS)
    : undefined;

  const superseded = new Promise<void>((_, reject) => {
    if (abortSignal.aborted) {
      reject(new Error(SUPERSEDED));
      return;
    }
    abortSignal.addEventListener("abort", () => reject(new Error(SUPERSEDED)));
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
    sessionLog(semlaSessionId, "bg continuation complete", {
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
      sessionLog(
        semlaSessionId,
        "bg continuation superseded — delivery will go to new session",
      );
    } else {
      sessionWarn(semlaSessionId, `bg continuation ended: ${msg}`);
      if (msg.includes("timed out")) {
        debug.onBgTimeout();
      } else {
        debug.onError(msg);
      }
    }
  } finally {
    if (watchdog) clearInterval(watchdog);
    unsubscribeBg();
    releaseBackgroundContinuation(semlaSessionId, abortSignal);
    detach(
      semlaSessionId,
      "clear running",
      setSessionRunning(semlaSessionId, false),
    );
    stampWikiRepo(semlaSessionId, projects, continuationStartedAt);
    if (supersededByNewPrompt) {
      // A new prompt took over this session. Do NOT dispose — that would kill the
      // shared bash executor and abort the new session's in-flight tool calls.
      sessionLog(
        semlaSessionId,
        "bg session released (not disposed — new session active)",
      );
    } else {
      sessionLog(semlaSessionId, "bg session disposed");
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
