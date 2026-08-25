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

export interface SessionDebugWriter {
  onPromptStart(text: string, model: string, tools: string[]): void;
  onSessionRestored(entryCount: number): void;
  onAssistantDelta(delta: string): void;
  onToolStart(toolName: string): void;
  onToolEnd(toolName: string, result?: unknown): void;
  onWorkflowSnapshot(snapshot: WorkflowSnapshot, mode: "background" | "foreground"): void;
  onError(message: string): void;
  onPersistEntry(index: number, total: number, ms: number): void;
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
  onAssistantDelta: () => {},
  onToolStart: () => {},
  onToolEnd: () => {},
  onWorkflowSnapshot: () => {},
  onError: () => {},
  onPersistEntry: () => {},
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
      appendEvent({ type: "prompt-start", model, tools, textLength: text.length });
    },

    onSessionRestored(entryCount: number) {
      appendEvent({ type: "session-restored", entries: entryCount });
    },

    onAssistantDelta(delta: string) {
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

    onPersistEntry(index: number, total: number, ms: number) {
      appendEvent({ type: "persist-entry", index, total, ms });
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
