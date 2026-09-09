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
import { queueEntries } from "@/lib/pi/entry-persist-queue";
import type { SessionDebugWriter } from "@/lib/pi/debug-writer";
import { asWorkflowSnapshot, liveSnapshot } from "@/lib/pi/session-events";
import { detach, sessionLog, sessionWarn } from "@/lib/pi/session-log";
import type { TurnOutcome } from "@/lib/pi/telemetry/host-recorder";
import {
  finalizeBackgroundRun,
  persistWorkflowSnapshot,
  setSessionRunning,
  type PiSessionEntry,
} from "@/lib/pi/session-persistence";
import {
  closeSessionStream,
  publishSessionRunning,
  publishToSessionStream,
} from "@/lib/pi/session-stream-store";
import { stampWikiRepo } from "@/lib/pi/session-wiki-stamp";
import { finishedRunMessage } from "@/lib/pi/workflow-delivery-message";
import { isRunTerminal, readWorkflowRun } from "@/lib/pi/workflow-run-reader";

/**
 * Poll interval for the delivery watchdog — the failsafe that self-delivers a
 * finished run if pi never generates the report turn (extension error,
 * version skew, delivery suspended). Not the client's update path: progress
 * now reaches the client the moment it happens, pushed onto the still-open
 * SSE stream from the `session.subscribe` callback below, the same way a
 * foreground run's snapshots do. Before the stream stayed open across the
 * handoff, this poll's read of the run file was incidentally the only way a
 * client could ever learn a background run had finished — forcing the client
 * onto its own 2s DB poll (use-workflow-runs.ts) for the whole time.
 */
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
  spans,
  timeoutMs = TIMEOUT_MS,
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
  /**
   * The turn's span, handed over because the run it parents outlives the turn
   * (plan §8.4). Optional so a caller with no telemetry needs to know nothing
   * about it.
   *
   * `flush` still writes to disk regardless of the stream: that write is the
   * only way a background run's spans reach the next page load, and it must
   * keep happening even after the stream this continuation owns has closed
   * (a superseded continuation, an aborted run) or was never subscribed to at
   * all.
   */
  spans?: {
    endTurn: (outcome: TurnOutcome) => void;
    flush: () => Promise<void>;
  };
  /**
   * Overrides `TIMEOUT_MS` for tests. No production caller passes this, so
   * the 30-minute ceiling is unchanged in real use.
   */
  timeoutMs?: number;
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
    // The session's own SSE stream, not only Supabase. session-service.ts kept
    // the stream open into this continuation for exactly this: before, the
    // stream closed the moment the prompt turn's own `finally` ran, so every
    // progress update after that point only ever reached a client through the
    // 2s use-workflow-runs.ts poll of this same write. A subscriber attached
    // to the stream now sees it immediately; the poll remains as the fallback
    // for the DB-write-lag race and a client that was never attached at all.
    publishToSessionStream(semlaSessionId, {
      snapshot: enriched,
      type: "workflow-snapshot",
    });
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
  // Set only when the outer race lost to `timeoutMs` and the run it was
  // watching is genuinely still not terminal — see the catch block below.
  let timedOutStillRunning = false;
  try {
    await Promise.race([
      deliveryStarted,
      superseded,
      new Promise<void>((_, reject) =>
        setTimeout(
          () => reject(new Error("background workflow delivery timed out")),
          timeoutMs,
        ),
      ),
    ]);
    await session.agent.waitForIdle();
    const entries = session.sessionManager.getEntries();
    sessionLog(semlaSessionId, "bg continuation complete", {
      entries: entries.length,
    });
    queueEntries(piSessionId, semlaSessionId, entries as PiSessionEntry[]);
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
        // Losing this race means "no delivery signal within timeoutMs", not
        // "the run finished". The watchdog above already distinguishes those
        // (isRunTerminal) — the outer race did not, and that gap is the bug:
        // treating a bare timeout as completion let the `finally` below run
        // the terminal sequence, including finalizeBackgroundRun, against a
        // run that was still working. Check the run's real status before
        // deciding anything below gets to touch it.
        if (runId !== undefined && !isRunTerminal(readWorkflowRun(agentCwd, runId))) {
          timedOutStillRunning = true;
          sessionWarn(
            semlaSessionId,
            `bg continuation for ${runId} timed out after ${timeoutMs}ms with the run still not terminal — leaving it "running" for fetchStuckBackgroundRuns to recover, instead of finalizing it as completed`,
          );
        }
      } else {
        debug.onError(msg);
      }
    }
  } finally {
    if (watchdog) clearInterval(watchdog);
    unsubscribeBg();
    // The turn span this continuation inherited. Closed here whatever happened
    // — a dropped stream or a timeout must still close it, or the trace claims
    // the turn is running forever.
    //
    // "suspended" covers both cases where this continuation stops watching
    // without the work being done: a new prompt took the session over, or the
    // watchdog timed out while the run was still going. Reporting the latter
    // as "completed" would make the trace assert the very thing the branch
    // below exists to deny — that a still-running run had finished.
    spans?.endTurn(
      supersededByNewPrompt || timedOutStillRunning ? "suspended" : "completed",
    );
    // Reaches disk, and — while the stream this continuation owns is still
    // open — the client too, via emit()'s use of publishToSessionStream.
    if (spans) await spans.flush();
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
      // Do NOT touch the stream either, for the same reason: the new prompt's
      // own runPiPrompt already called openSessionStream() for this session id
      // in the same tick it armed the continuation that replaced this one, so
      // the stream this continuation started watching is not the stream a
      // client is subscribed to any more. Closing it here would tear down the
      // new turn's stream out from under it.
    } else if (timedOutStillRunning) {
      // Already logged above, at the point the timeout was diagnosed. Nothing
      // here disposes the session or finalizes the run: the index still
      // correctly has it as "running", which is exactly the status
      // fetchStuckBackgroundRuns and session-service.ts's own recovery path
      // look for on the next turn. Writing "completed" over it now — the one
      // status that recovery never looks for — is what made the run
      // unrecoverable before this branch existed.
    } else {
      // This continuation is the one still holding the stream open across the
      // handoff (session-service.ts's `watch` branch left it open on purpose).
      // Nothing superseded it, so this really is the end: tell the client the
      // run has stopped and close the connection, the same terminal sequence
      // runPiPrompt itself uses when a turn's `finally` decides there is
      // nothing left to watch.
      publishSessionRunning(semlaSessionId, false);
      publishToSessionStream(semlaSessionId, { type: "complete" });
      closeSessionStream(semlaSessionId);

      sessionLog(semlaSessionId, "bg session disposed");
      if (runId) {
        // Disposes the session and drops it from the retained map, which would
        // otherwise keep a dead session (and its bash executor) referenced.
        releaseBackgroundSession(runId);
        await finalizeBackgroundRun(semlaSessionId, runId, "completed");
      } else {
        session.dispose();
      }
    }
  }
};
