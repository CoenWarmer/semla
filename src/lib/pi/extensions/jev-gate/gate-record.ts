/**
 * The shape of what a gate decision leaves behind in the session, so the UI
 * can say why a turn had the tools it had.
 *
 * Imported by both the extension that writes it and the React component that
 * reads it, which is why it is its own module: the component must not pull in
 * `jev-client.ts` and its `node:fs` credential read, and the extension must not
 * pull in anything from `src/components`.
 *
 * Persisted as a `custom_message` entry rather than a span alone. Spans are the
 * right home for "what did this cost and how long did it take", and §4 of the
 * plan keeps them; they are not readable by the conversation view, and §8 asks
 * for the decision to be visible next to the prompt it applied to. Both exist,
 * and the reason is traceability: "why doesn't this session have tool X" has to
 * be answerable without re-running the turn.
 */

/** Matches the plan's naming for the span, so the two are searchable together. */
export const JEV_GATE_CUSTOM_TYPE = "jev-gate-decision";

export type JevGateOutcome = "decided" | "fail-closed" | "unconfigured";

export interface JevGateRecord {
  outcome: JevGateOutcome;
  /** Tool names the agent was left with, floor included. */
  tools: string[];
  /** Skill names left in the system prompt. */
  skills: string[];
  /** Every candidate with its probability, including the ones dropped. */
  toolScores: Record<string, number>;
  skillScores: Record<string, number>;
  /** Names that were candidates but did not clear the threshold. */
  droppedTools: string[];
  droppedSkills: string[];
  /** Whether `mcp`/`mcpScript` survived — the plan's coarse "sources" axis. */
  mcpAllowed: boolean;
  threshold: number;
  /** Present when the outcome is not "decided". */
  reason?: string;
  elapsedMs?: number;
  model?: string;
  costUsd?: number;
  /** Which evaluation in the turn this was: 1 for the first, 2 for a re-check. */
  evaluation: number;
}

/** Type guard for the parsed content of a persisted entry. */
export function isJevGateRecord(value: unknown): value is JevGateRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.outcome === "decided" ||
      record.outcome === "fail-closed" ||
      record.outcome === "unconfigured") &&
    Array.isArray(record.tools) &&
    Array.isArray(record.skills)
  );
}

/**
 * Parse a persisted record, returning null rather than throwing.
 *
 * The content is JSON in a session file this process did not necessarily
 * write — an older Semla, or a hand-edited file — so a bad record must degrade
 * to "no badge" and never to a failed render of the conversation.
 */
export function parseJevGateRecord(content: unknown): JevGateRecord | null {
  let value: unknown = content;
  if (typeof content === "string") {
    try {
      value = JSON.parse(content);
    } catch {
      return null;
    }
  }
  return isJevGateRecord(value) ? value : null;
}
