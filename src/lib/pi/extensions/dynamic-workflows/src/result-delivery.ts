/**
 * Background-run result delivery: when a background run finishes, its result is
 * delivered back into the conversation so the paused task continues with the
 * outcome.
 *
 * This was the live half of `task-panel.ts`. The other half rendered a pi-tui
 * widget listing in-progress runs below the input, and every line of it was
 * unreachable here: Semla binds its extensions with `mode: "print"`, which
 * leaves `ctx.hasUI` false and the UI methods as no-ops, and it renders the
 * same information in its own React workflow panel. Delivery has nothing to do
 * with the TUI — it goes out over `pi.sendMessage` — which is why the file was
 * split rather than deleted.
 */

import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fmtCost, fmtTokenSegment, tokenFigures } from "./display.ts";
import type { ManagedRun, WorkflowManager } from "./workflow-manager.ts";
import type { WorkflowSettings } from "./workflow-settings.ts";

/** Default cap on the JSON-dump fallback in a delivered result summary. Overridable
 *  via the `deliveredResultMaxChars` setting in .semla-state/workflows/settings.json. */
const DEFAULT_DELIVERED_MAX_CHARS = 400;

/** Human-readable byte size for the dropped-tail hint: 512 B, 3.2 KB, 1.4 MB. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Compact token count for a one-line summary: 980, 12.4K, 1.3M. */
function fmtTokensShort(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 1000) return `${Math.round(n)}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * Pick a clean human-readable summary from a workflow result, in order of
 * preference: a `verdict`/`report`/`summary`/`synthesis` string field, a bare
 * string result, else a JSON dump capped at `maxChars`. When the dump is truncated the
 * dropped size is reported (the full result is still reachable via the pointer
 * that {@link deliverText} appends).
 */
function summarizeResult(result: unknown, maxChars: number = DEFAULT_DELIVERED_MAX_CHARS): string {
  if (typeof result === "string") return result;
  if (result == null) return "null";
  if (typeof result === "object") {
    const obj = result as Record<string, unknown>;
    // `synthesis` is what the built-in multi-perspective workflow returns.
    for (const key of ["verdict", "report", "summary", "synthesis"] as const) {
      const val = obj[key];
      if (typeof val === "string" && val.trim()) return val;
    }
  }
  const json = JSON.stringify(result, null, 2);
  if (json.length <= maxChars) return json;
  // Slice once (the kept head); derive the dropped size by byte-length subtraction
  // so we don't also allocate the (potentially large) truncated tail to measure it.
  const kept = json.slice(0, maxChars);
  const droppedBytes = Buffer.byteLength(json, "utf8") - Buffer.byteLength(kept, "utf8");
  return `${kept}\n…(truncated ${formatBytes(droppedBytes)})`;
}

export function deliverText(run: ManagedRun, opts: { resultPath?: string; maxChars?: number } = {}): string {
  const summary = summarizeResult(run.result?.result, opts.maxChars);
  const tu = run.result?.tokenUsage;
  const cost = tu?.cost ? ` · ${fmtCost(tu.cost)}` : "";
  const segment = fmtTokenSegment(tokenFigures(tu), fmtTokensShort);
  const tokens = `${segment ? ` · ${segment}` : ""}${cost}`;
  const agents = run.result?.agentCount ?? run.snapshot.agentCount;
  const duration = run.result?.durationMs ? ` · ${(run.result.durationMs / 1000).toFixed(1)}s` : "";
  const lines = [
    `✓ Background workflow "${run.snapshot.name}" finished (${agents} agents${tokens}${duration}).`,
    "",
    summary,
  ];
  // Always point at the full persisted result so the tail is never lost — even when
  // the summary above is a complete verdict/summary field or an untruncated dump.
  if (opts.resultPath) lines.push("", `↳ Full result: ${opts.resultPath}`);
  return lines.join("\n");
}

/** Absolute path to a run's persisted result JSON. Undefined if the persistence
 *  layer can't be resolved — delivery must never throw in the complete handler. */
function persistedResultPath(manager: WorkflowManager, runId: string): string | undefined {
  try {
    return join(manager.getPersistence().getRunsDir(), `${runId}.json`);
  } catch {
    return undefined;
  }
}

/** Delivered JSON-dump truncation threshold from settings (already normalized),
 *  defaulting to 400 when unset or unreadable. */
function deliveredMaxChars(opts: { loadSettings?: () => WorkflowSettings }): number {
  try {
    return opts.loadSettings?.().deliveredResultMaxChars ?? DEFAULT_DELIVERED_MAX_CHARS;
  } catch {
    return DEFAULT_DELIVERED_MAX_CHARS;
  }
}

/**
 * Generation-bound delivery state lives on the manager so listeners registered
 * once can keep working across session replacements (/reload, /new, resume,
 * fork). See installResultDelivery / suspendResultDelivery.
 */
interface DeliveryHolder {
  pi: ExtensionAPI;
  loadSettings?: () => WorkflowSettings;
  /**
   * When true, do not call pi.sendMessage — only enqueue. Set for the whole
   * window between session_shutdown and the next generation's install, so a
   * completion cannot land on a dying session (or a just-invalidated ctx).
   */
  suspended: boolean;
  /** Contents that failed to send or arrived while suspended; flushed on resume. */
  pending: string[];
  /**
   * Generation counter bumped on every install/refresh. An in-flight send's
   * rejection handler captures the generation it started under; if a newer
   * generation has already installed by the time the rejection lands, the
   * handler must flush immediately — otherwise the content sits in `pending`
   * until some later install happens to run.
   */
  generation: number;
}

type DeliveryManager = WorkflowManager & {
  __deliveryInstalled?: boolean;
  __holder?: DeliveryHolder;
};

function deliveryManager(manager: WorkflowManager): DeliveryManager {
  return manager as DeliveryManager;
}

function enqueuePending(holder: DeliveryHolder, content: string): void {
  // Soft-cap only: warn loudly, never drop. The full result is also on disk
  // via the run JSON pointer in deliverText, but conversation delivery is the
  // contract the tool promises — silent shift() would break it.
  if (holder.pending.length >= 32) {
    console.warn(
      `[workflow-delivery] pending queue at ${holder.pending.length} entries; ` +
        "delivery is stalled (no successful flush since suspend/failure). " +
        "Results remain on disk via /workflows.",
    );
  }
  holder.pending.push(content);
}

function trySend(holder: DeliveryHolder, content: string): void {
  const startedGeneration = holder.generation;
  try {
    const ret = holder.pi.sendMessage(
      { customType: "workflow-result", content, display: true },
      { triggerTurn: true, deliverAs: "followUp" },
    );
    // sendMessage may return a promise (defensive — current pi types it void).
    // On rejection: re-queue, and if a newer generation already installed
    // while we were in flight, flush now so the content is not stranded.
    void Promise.resolve(ret).catch((err: unknown) => {
      enqueuePending(holder, content);
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[workflow-delivery] async send failed; queued for retry: ${msg}`);
      if (holder.generation !== startedGeneration && !holder.suspended) {
        flushPending(holder);
      }
    });
  } catch (err) {
    enqueuePending(holder, content);
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[workflow-delivery] send failed; queued for retry: ${msg}`);
  }
}

function flushPending(holder: DeliveryHolder): void {
  if (holder.suspended || holder.pending.length === 0) return;
  const queued = holder.pending.splice(0, holder.pending.length);
  for (const content of queued) trySend(holder, content);
}

/**
 * Stop live sends on this manager. In-flight completions only enqueue until
 * {@link resumeResultDelivery} runs (from session_start, after Pi has bound
 * the extension runtime) or the process exits (quit — results stay on disk).
 *
 * Call from session_shutdown BEFORE handoff or discard so a completion that
 * races the teardown cannot deliver into the outgoing session.
 */
export function suspendResultDelivery(manager: WorkflowManager): void {
  const holder = deliveryManager(manager).__holder;
  if (holder) holder.suspended = true;
}

/**
 * Unsuspend and flush any queued deliveries. Must run only after Pi has
 * finished constructing the AgentSession and bound sendMessage (i.e. from
 * session_start) — calling it from the extension factory hits the
 * "runtime not initialized" stub and re-queues forever.
 */
export function resumeResultDelivery(manager: WorkflowManager): void {
  const holder = deliveryManager(manager).__holder;
  if (!holder) return;
  holder.suspended = false;
  flushPending(holder);
}

/**
 * When a background run finishes (or fails), deliver its result back into the
 * conversation AND continue the turn so the assistant can act on it — without
 * blocking the user meanwhile:
 *
 *  - `triggerTurn: true` starts a fresh turn when the agent is idle, feeding the
 *    result to the model so the paused conversation continues.
 *  - `deliverAs: "followUp"` means that if the user is busy in another turn, the
 *    result is queued and picked up after that turn finishes — never interrupting.
 *
 * Set up once per extension; idempotent via an internal guard. Across session
 * replacement the manager (and this listener) survive via the handoff path;
 * each new generation only refreshes `holder.pi` and flushes any messages that
 * failed or arrived while delivery was suspended.
 */
export function installResultDelivery(
  pi: ExtensionAPI,
  manager: WorkflowManager,
  opts: { loadSettings?: () => WorkflowSettings } = {},
): void {
  const m = deliveryManager(manager);
  if (m.__deliveryInstalled) {
    // The manager and listeners survive session replacement. Refresh every
    // generation-bound dependency and bump the generation (so in-flight
    // rejects from the previous pi can self-flush once resumed). Do NOT
    // unsuspend or flush here: the factory runs before Pi bindCore(), so
    // sendMessage is still the "runtime not initialized" stub. session_start
    // calls resumeResultDelivery() once the runtime is live.
    if (m.__holder) {
      m.__holder.pi = pi;
      m.__holder.loadSettings = opts.loadSettings;
      m.__holder.generation += 1;
    }
    return;
  }
  m.__deliveryInstalled = true;
  m.__holder = { pi, loadSettings: opts.loadSettings, suspended: false, pending: [], generation: 0 };

  const deliver = (content: string) => {
    const holder = m.__holder;
    if (!holder) return;
    if (holder.suspended) {
      enqueuePending(holder, content);
      return;
    }
    trySend(holder, content);
  };

  manager.on("complete", ({ runId }: { runId: string }) => {
    const run = manager.getRun(runId);
    // Only background/resumed runs are delivered: a foreground (sync) run already
    // returns its result inline as the tool result, so re-delivering would dup it.
    // suppressDelivery opts out for fire-and-forget runs (e.g. wiki-ingest-bridge).
    if (run?.background && !run.suppressDelivery) {
      deliver(
        deliverText(run, {
          resultPath: persistedResultPath(manager, runId),
          maxChars: deliveredMaxChars({ loadSettings: m.__holder?.loadSettings }),
        }),
      );
    }
  });
  manager.on("error", ({ runId, error }: { runId: string; error?: { message?: string } }) => {
    if (!manager.getRun(runId)?.background) return;
    if (manager.getRun(runId)?.suppressDelivery) return;
    deliver(`✗ Background workflow ${runId} failed: ${error?.message ?? "unknown error"}`);
  });
  // A provider usage/quota limit checkpoints the run as paused (not failed): tell the
  // user it is resumable once their budget refills, rather than letting it look dead.
  // Manual pause() also emits "paused" but with no reason — guard so only the
  // usage-limit case delivers a message.
  manager.on(
    "paused",
    ({
      runId,
      reason,
      error,
      resetHint,
    }: {
      runId: string;
      reason?: string;
      error?: { message?: string };
      resetHint?: string;
    }) => {
      if (reason !== "usage_limit") return;
      if (!manager.getRun(runId)?.background) return;
      if (manager.getRun(runId)?.suppressDelivery) return;
      const when = resetHint ? ` (${resetHint})` : "";
      const cause = error?.message ?? "provider usage limit reached";
      deliver(
        `⏸ Background workflow ${runId} paused: ${cause}${when}. ` +
          `Completed steps are saved — run /workflows resume ${runId} once your usage limit resets.`,
      );
    },
  );
}
