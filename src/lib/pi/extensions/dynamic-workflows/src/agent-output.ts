/**
 * Reading a finished subagent turn: what the model actually produced, and the
 * terminal conditions the pi SDK records instead of throwing.
 *
 * Split out of agent.ts (whose `WorkflowAgent.run` is the only caller) because
 * all but one of these are pure reads over a message array or a signals record,
 * so they can be exercised against literal arrays with no session at all —
 * agent-output.test.ts does exactly that.
 *
 * The exception is `resolveStructuredOutput`, which drives repair turns and so
 * takes the narrow {@link StructuredSession} rather than a real AgentSession;
 * its tests pass a double. It lives here anyway because its fallback path IS
 * the prose read (`extractValidated` over `lastAssistantText`), and splitting
 * the two would separate a decision from the evidence it rests on.
 */

import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import { Check, Convert } from "typebox/value";
import type { AgentContextSignals } from "./agent-context-signals.ts";
import type { AgentUsage, StructuredSession } from "./agent-types.ts";
import {
  classifyProviderLimit,
  WorkflowError,
  WorkflowErrorCode,
} from "./errors.ts";
import type { StructuredOutputCapture } from "./structured-output.ts";

/**
 * Find a JSON object/array in free-form text: a fenced ```json block if present,
 * else the first balanced {...} or [...]. Best-effort (the schema check is the
 * real gate). Returns the raw JSON string, or undefined when none is found.
 */
function findJsonBlock(text: string): string | undefined {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) return fence[1].trim();
  const start = text.search(/[{[]/);
  if (start === -1) return undefined;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close && --depth === 0)
      return text.slice(start, i + 1);
  }
  return undefined;
}

/**
 * Last-resort structured-output recovery: extract a JSON block from prose, coerce
 * it toward the schema, and accept it only if it then validates. Never fabricates
 * — returns undefined unless the parsed value genuinely satisfies the schema.
 */
export function extractValidated<T>(
  text: string,
  schema: TSchema,
): T | undefined {
  const json = findJsonBlock(text);
  if (json === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  try {
    const converted = Convert(schema, parsed);
    if (Check(schema, converted)) return converted as T;
  } catch {
    // typebox can throw on exotic schemas; treat as no match.
  }
  return undefined;
}

/**
 * The last assistant message's terminal metadata (stopReason/errorMessage). The pi
 * SDK does NOT throw provider usage/quota limits — it records them as an assistant
 * message with stopReason "error" and an errorMessage. This is the only place that
 * metadata is observable to the workflow layer.
 */
export function lastAssistantError(
  messages: unknown[],
): { stopReason?: string; errorMessage?: string } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as Partial<AssistantMessage> | undefined;
    if (message?.role !== "assistant") continue;
    return {
      stopReason: message.stopReason,
      errorMessage: message.errorMessage,
    };
  }
  return undefined;
}

/**
 * If the subagent's turn ended in a provider usage/quota/rate-limit error, throw a
 * PROVIDER_USAGE_LIMIT WorkflowError carrying the real provider message + reset hint.
 * Gated on stopReason === "error" so a successful turn whose text merely mentions
 * "rate limit" is never misclassified. recoverable:false so the run checkpoints
 * (paused) rather than being retried into the same wall or collapsed to a silent null.
 */
export function throwIfProviderLimit(
  messages: unknown[],
  label?: string,
): void {
  const err = lastAssistantError(messages);
  if (err?.stopReason !== "error") return;
  const { matched, resetHint } = classifyProviderLimit(err.errorMessage);
  if (!matched) return;
  throw new WorkflowError(
    err.errorMessage ?? "Provider usage/quota limit reached",
    WorkflowErrorCode.PROVIDER_USAGE_LIMIT,
    { recoverable: false, agentLabel: label, resetHint },
  );
}

/**
 * True when pi's own overflow recovery (docs/plans/subagent-context-pressure.md
 * §2.2) ran and failed — i.e. a compaction_end event whose `errorMessage` is set
 * for an "overflow" reason. pi never throws this itself (it just returns `false`
 * from `_checkCompaction` and lets the turn's stopReason stand), so this is the
 * one place that failure becomes observable to the workflow layer, matching how
 * throwIfProviderLimit is the one place a buried provider-limit message becomes
 * observable.
 */
function hasFailedOverflowRecovery(signals: AgentContextSignals): boolean {
  return signals.events.some(
    (event) => event.reason === "overflow" && event.errorMessage !== undefined,
  );
}

/**
 * True when the subagent's own captured signals say it ran out of context:
 * either pi's overflow-recovery compact-and-retry already ran once for this
 * session and still failed (hasFailedOverflowRecovery), or the terminal
 * assistant message stopped at "length" — the SDK's own signal (see
 * pi-ai's isRecoverableLength/isContextOverflow) that the model's output was
 * cut short by a limit, not a normal stop. Exported so a caller assembling
 * the partial-result opt-in (agent()'s onContextExhausted: "partial") can
 * reuse the exact same test rather than re-deriving it.
 */
export function isContextExhausted(signals: AgentContextSignals): boolean {
  return signals.stopReason === "length" || hasFailedOverflowRecovery(signals);
}

/**
 * If the subagent's captured context-pressure signals (agent-context-signals.ts,
 * fed by the same session.subscribe(...) stream throwIfProviderLimit's caller
 * already reads for stopReason) say the subagent ran out of context, throw a
 * non-recoverable AGENT_CONTEXT_EXHAUSTED WorkflowError. Lives next to
 * throwIfProviderLimit deliberately — both read terminal session metadata to
 * turn a condition the SDK itself never throws into a workflow-visible failure
 * (docs/plans/subagent-context-pressure.md §6). recoverable:false: retrying
 * walks straight back into the same wall pi's own overflow recovery already hit
 * once, per errors.ts's AGENT_CONTEXT_EXHAUSTED doc comment.
 */
export function throwIfContextExhausted(
  signals: AgentContextSignals,
  label?: string,
): void {
  if (!isContextExhausted(signals)) return;
  throw new WorkflowError(
    "Subagent ran out of context (compaction and retry could not recover)",
    WorkflowErrorCode.AGENT_CONTEXT_EXHAUSTED,
    { recoverable: false, agentLabel: label },
  );
}

/**
 * Resolve a schema agent's result. If the tool was called, return the captured
 * value. Otherwise re-prompt up to maxSchemaRetries (tools restricted to
 * structured_output), then try strict schema-validated prose extraction, else
 * throw SCHEMA_NONCOMPLIANCE (non-recoverable — surfaced, never a silent null).
 * Module-level with an injected `lastText` so it is unit-testable.
 */
export async function resolveStructuredOutput<T>(
  session: StructuredSession,
  capture: StructuredOutputCapture<T>,
  schema: TSchema,
  options: { maxSchemaRetries?: number; signal?: AbortSignal; label?: string },
  lastText: (messages: unknown[]) => string,
): Promise<T> {
  if (capture.called) return capture.value as T;

  const maxRetries = Math.max(0, options.maxSchemaRetries ?? 2);
  // Restrict to the schema tool so the only useful next action is calling it
  // (takes effect on the next prompt turn). Best-effort.
  try {
    session.setActiveToolsByName?.(["structured_output"]);
  } catch {
    // ignore — the re-prompt alone still drives most models to comply
  }
  for (let attempt = 0; attempt < maxRetries && !capture.called; attempt++) {
    if (options.signal?.aborted) throw new Error("Subagent was aborted");
    await session.prompt(
      "You did not call the structured_output tool. Call structured_output now as your only action, with the required fields filled in. Do not write a prose answer.",
    );
  }
  if (capture.called) return capture.value as T;

  const extracted = extractValidated<T>(lastText(session.messages), schema);
  if (extracted !== undefined) {
    console.warn(
      "[workflow] structured_output recovered from prose extraction (the model never called the tool); prefer a tool-reliable model",
    );
    return extracted;
  }

  // A repair re-prompt can itself hit the provider limit. Surface that as the real
  // (recoverable) cause instead of the misleading non-recoverable SCHEMA_NONCOMPLIANCE.
  throwIfProviderLimit(session.messages, options.label);

  throw new WorkflowError(
    "Subagent did not produce valid structured_output after repair attempts",
    WorkflowErrorCode.SCHEMA_NONCOMPLIANCE,
    { recoverable: false, agentLabel: options.label },
  );
}

/**
 * Map session stats to an AgentUsage, or undefined when the provider reported
 * no usage at all (all-zero stats). Returning undefined — instead of a zero
 * breakdown — lets displays fall back to their scalar token count, so setups
 * on non-reporting providers render the same as before the split existed.
 */
export function usageFromStats(stats: {
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
}): AgentUsage | undefined {
  const { tokens, cost } = stats;
  if (tokens.total <= 0 && cost <= 0) return undefined;
  return {
    input: tokens.input,
    output: tokens.output,
    cacheRead: tokens.cacheRead,
    cacheWrite: tokens.cacheWrite,
    total: tokens.total,
    cost,
  };
}

/**
 * The most recent assistant text anywhere in the transcript. Deliberately
 * lenient: the schema path's prose-JSON recovery (resolveStructuredOutput) may
 * need to read the structured payload out of any assistant message, not only
 * the terminal one.
 */
export function lastAssistantText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as Partial<AssistantMessage> | undefined;
    if (message?.role !== "assistant" || !Array.isArray(message.content))
      continue;
    const text = message.content
      .filter((part): part is TextContent => part.type === "text")
      .map((part) => part.text)
      .join("");
    if (text.trim()) return text;
  }
  return "";
}

/**
 * The unstructured agent's FINAL answer: assistant text that appears after the
 * last tool result. Text before the final tool result is stale progress (the
 * agent's last real action was a tool call, not answering), so returning it
 * would mask an incomplete run and suppress AGENT_EMPTY_OUTPUT retries (#111).
 *
 * Distinct from lastAssistantText(), which stays deliberately lenient — the
 * schema path's prose-JSON recovery (resolveStructuredOutput) may need to read
 * the structured payload out of any assistant message, not only the terminal one.
 */
export function finalAssistantText(messages: unknown[]): string {
  // Locate the last tool result; only assistant text strictly after it counts.
  let lastToolResult = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (
      (messages[i] as { role?: string } | undefined)?.role === "toolResult"
    ) {
      lastToolResult = i;
      break;
    }
  }
  for (let i = messages.length - 1; i > lastToolResult; i--) {
    const message = messages[i] as Partial<AssistantMessage> | undefined;
    if (message?.role !== "assistant" || !Array.isArray(message.content))
      continue;
    const text = message.content
      .filter((part): part is TextContent => part.type === "text")
      .map((part) => part.text)
      .join("");
    if (text.trim()) return text;
  }
  return "";
}
