import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkflowSnapshot } from "@/types/workflow";

const DEV = process.env.NODE_ENV === "development";
const DEBUG_ROOT = join(process.cwd(), ".semla-debug", "sessions");

const TOOL_RESULT_MAX = 2_000;

function truncate(value: unknown, max: number): string {
  const s =
    typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "";
  return s.length > max ? `${s.slice(0, max)}\n…(truncated ${s.length - max} chars)` : s;
}

function ts(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19) + "Z";
}

/**
 * The phases of a turn between the prompt arriving and the first entry being
 * persisted.
 *
 * Everything here used to be one unrecorded window. A session that took 81
 * seconds to answer "Hi how's it going?" produced an artifact in which the
 * first event was the prompt and the next was a persisted entry 78 seconds
 * later, so a stalled model request, a cold extension compile and an
 * unreachable database were indistinguishable after the fact — in a tool whose
 * point is traceability. Each phase now reports its own duration, because the
 * event timestamps are only second-resolution.
 */
export type SessionPhase =
  /** Resolving the model through ModelRuntime, including its availability fetch. */
  | "model-resolved"
  /** Reading the session's entries back out of Supabase and onto disk. */
  | "session-loaded"
  /** jiti compiling the path-loaded extensions. */
  | "extensions-compiled"
  /** createAgentSession. */
  | "agent-created"
  /** bindExtensions — where extension tools register and slots are published. */
  | "extensions-bound"
  /** Looking for background runs whose delivery was lost. */
  | "stuck-runs-checked"
  /** The agent loop: the model request and everything it drives. */
  | "model-turn";

export interface SessionDebugWriter {
  onPromptStart(text: string, model: string, tools: string[]): void;
  onSessionRestored(entryCount: number): void;
  /** A phase completed, having taken `ms`. */
  onPhase(phase: SessionPhase, ms: number): void;
  /**
   * The model request is about to go out. Starts the clock that the first
   * assistant byte is measured against — the number that separates "the
   * provider stalled" from "we were slow to get there".
   */
  onModelRequestStart(): void;
  onAssistantDelta(delta: string): void;
  onToolStart(toolName: string): void;
  onToolEnd(toolName: string, result?: unknown): void;
  onWorkflowSnapshot(snapshot: WorkflowSnapshot, mode: "background" | "foreground"): void;
  onError(message: string): void;
  /**
   * Entries handed to the persistence queue: how many were new, out of how
   * many the conversation now holds. Replaces a per-entry event, because the
   * turn no longer writes them one at a time or waits for them at all.
   */
  onEntriesQueued(queued: number, total: number): void;
  onPromptComplete(entryCount: number, hasBackground: boolean): void;
  onSseComplete(): void;
  onBgStart(): void;
  onBgDelivery(): void;
  onBgComplete(entryCount: number): void;
  onBgTimeout(): void;
}

// Shared no-op instance for non-dev environments.
const NOP: SessionDebugWriter = {
  onPromptStart: () => {},
  onSessionRestored: () => {},
  onPhase: () => {},
  onModelRequestStart: () => {},
  onAssistantDelta: () => {},
  onToolStart: () => {},
  onToolEnd: () => {},
  onWorkflowSnapshot: () => {},
  onError: () => {},
  onEntriesQueued: () => {},
  onPromptComplete: () => {},
  onSseComplete: () => {},
  onBgStart: () => {},
  onBgDelivery: () => {},
  onBgComplete: () => {},
  onBgTimeout: () => {},
};

/**
 * Writes session artifacts to .semla-debug/sessions/{id}/ in dev mode:
 *
 *   conversation.md     — human-readable transcript, updated incrementally
 *   events.jsonl        — every event as a JSON line
 *   workflow-{id}.json  — latest snapshot per workflow run (overwritten each update)
 *
 * All writes are synchronous so ordering is guaranteed inside event callbacks.
 * No-ops when NODE_ENV !== "development".
 */
export function createSessionDebugWriter(semlaSessionId: string): SessionDebugWriter {
  if (!DEV) {
    return NOP;
  }

  const dir = join(DEBUG_ROOT, semlaSessionId);
  mkdirSync(dir, { recursive: true });

  const convoFile = join(dir, "conversation.md");
  const eventsFile = join(dir, "events.jsonl");

  let inAssistantBlock = false;
  /** Set by onPromptStart, so phases can be placed on one timeline. */
  let promptStartedAt = Date.now();
  /**
   * When the model request went out, and whether its first byte is still
   * unreported. Cleared once reported so the background report turn's deltas
   * are not measured against a request that finished long ago.
   */
  let modelRequestAt: number | undefined;

  function appendConvo(text: string) {
    appendFileSync(convoFile, text, "utf8");
  }

  function closeAssistantBlock() {
    if (inAssistantBlock) {
      appendConvo("\n\n");
      inAssistantBlock = false;
    }
  }

  function appendEvent(event: Record<string, unknown>) {
    appendFileSync(eventsFile, JSON.stringify({ t: ts(), ...event }) + "\n", "utf8");
  }

  return {
    onPromptStart(text: string, model: string, tools: string[]) {
      const isNew = !existsSync(convoFile);

      if (isNew) {
        writeFileSync(
          convoFile,
          `# Session ${semlaSessionId}\n\n**Model:** ${model}  \n**Tools:** ${tools.join(", ")}\n`,
          "utf8",
        );
      } else {
        appendConvo(
          `\n---\n\n<!-- resumed ${ts()} · model=${model} -->\n`,
        );
      }

      appendConvo(`\n---\n\n## User · ${ts()}\n\n${text}\n`);
      promptStartedAt = Date.now();
      modelRequestAt = undefined;
      appendEvent({ type: "prompt-start", model, tools, textLength: text.length });
    },

    onSessionRestored(entryCount: number) {
      appendEvent({ type: "session-restored", entries: entryCount });
    },

    // Timing only — the transcript stays readable, the attribution lives in
    // events.jsonl.
    onPhase(phase: SessionPhase, ms: number) {
      appendEvent({
        type: "phase",
        phase,
        ms,
        sincePromptMs: Date.now() - promptStartedAt,
      });
    },

    onModelRequestStart() {
      modelRequestAt = Date.now();
      appendEvent({
        type: "model-request-start",
        sincePromptMs: modelRequestAt - promptStartedAt,
      });
    },

    onAssistantDelta(delta: string) {
      // The first byte back from the provider. Emitted from here rather than
      // asked of the caller: the event router that sees the deltas has no
      // reason to know when the request went out.
      if (modelRequestAt !== undefined) {
        appendEvent({
          type: "first-token",
          ms: Date.now() - modelRequestAt,
          sincePromptMs: Date.now() - promptStartedAt,
        });
        modelRequestAt = undefined;
      }

      if (!inAssistantBlock) {
        appendConvo(`\n---\n\n## Assistant · ${ts()}\n\n`);
        inAssistantBlock = true;
      }
      appendConvo(delta);
    },

    onToolStart(toolName: string) {
      closeAssistantBlock();
      appendConvo(`\n> **\`${toolName}\`** started · ${ts()}\n`);
      appendEvent({ type: "tool-start", tool: toolName });
    },

    onToolEnd(toolName: string, result?: unknown) {
      const preview = result !== undefined ? truncate(result, TOOL_RESULT_MAX) : undefined;
      appendConvo(`> **\`${toolName}\`** ended · ${ts()}\n${preview ? `\n<details><summary>result</summary>\n\n\`\`\`\n${preview}\n\`\`\`\n\n</details>\n` : ""}`);
      appendEvent({ type: "tool-end", tool: toolName, ...(preview ? { resultPreview: preview } : {}) });
    },

    onWorkflowSnapshot(snapshot: WorkflowSnapshot, mode: "background" | "foreground") {
      if (!snapshot.runId) return;
      const snapshotFile = join(dir, `workflow-${snapshot.runId}.json`);
      writeFileSync(
        snapshotFile,
        JSON.stringify({ ...snapshot, _mode: mode, _updatedAt: ts() }, null, 2),
        "utf8",
      );
      appendEvent({
        type: "workflow-snapshot",
        mode,
        run: snapshot.runId,
        agents: `${snapshot.doneCount}/${snapshot.agentCount}`,
        running: snapshot.runningCount,
        errors: snapshot.errorCount,
      });
    },

    onError(message: string) {
      closeAssistantBlock();
      appendConvo(`\n> ⚠️ **Error:** ${message} · ${ts()}\n`);
      appendEvent({ type: "error", message });
    },

    onEntriesQueued(queued: number, total: number) {
      appendEvent({ type: "entries-queued", queued, total });
    },

    onPromptComplete(entryCount: number, hasBackground: boolean) {
      closeAssistantBlock();
      appendConvo(
        `\n---\n\n_Prompt complete · ${ts()} · ${entryCount} entries persisted${hasBackground ? " · background workflow running" : ""}_\n`,
      );
      appendEvent({ type: "prompt-complete", entries: entryCount, hasBackground });
    },

    onSseComplete() {
      appendEvent({ type: "sse-complete" });
    },

    onBgStart() {
      appendConvo(`\n---\n\n_Background continuation started · ${ts()}_\n`);
      appendEvent({ type: "bg-start" });
    },

    onBgDelivery() {
      appendConvo(`\n---\n\n## Assistant (delivery) · ${ts()}\n\n`);
      inAssistantBlock = true;
      appendEvent({ type: "bg-delivery" });
    },

    onBgComplete(entryCount: number) {
      closeAssistantBlock();
      appendConvo(`\n---\n\n_Background complete · ${ts()} · ${entryCount} entries persisted_\n`);
      appendEvent({ type: "bg-complete", entries: entryCount });
    },

    onBgTimeout() {
      closeAssistantBlock();
      appendConvo(`\n---\n\n_Background timed out · ${ts()}_\n`);
      appendEvent({ type: "bg-timeout" });
    },
  };
}
