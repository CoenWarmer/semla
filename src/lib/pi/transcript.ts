import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/types/database.types";
import { readSessionEntries, type TranscriptRow } from "@/lib/pi/session-file";

type PiUsage = {
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total: number };
  input?: number;
  totalTokens?: number;
};

export type PiMessage = {
  content: unknown;
  isError?: boolean;
  role: string;
  toolCallId?: string;
  usage?: PiUsage;
};

export type SessionTranscriptEntry = {
  createdAt: string;
  id: string;
  inputTokens?: number;
  role: "assistant" | "user";
  text: string;
  /** The model's reasoning for this turn, when the provider returned any. */
  thinking?: string;
  tokenUsage?: { cost: number; total: number };
};

/**
 * A tool the assistant invoked. These are not conversation messages — they are
 * the actions taken between them, surfaced so the timeline can mark when each
 * one fired. `messageId` is the entry the call belongs to, so a marker can
 * still scroll to the right place in the transcript.
 */
export type SessionToolCall = {
  createdAt: string;
  errorText?: string;
  id: string;
  isError?: boolean;
  messageId: string;
  name: string;
  params?: Record<string, string>;
  resultAt?: string;
  resultText?: string;
  summary?: string;
};

export type SessionTranscript = {
  messages: SessionTranscriptEntry[];
  toolCalls: SessionToolCall[];
};

/** Scalar arguments as truncated strings, for display in the detail drawer. */
export const getParams = (value: unknown): Record<string, string> | undefined => {
  if (!isRecord(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(value)) {
    if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
      result[key] = String(val).slice(0, 8000);
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
};

/** First scalar argument, for a marker tooltip: `bash: npm test`. */
export const summarizeArguments = (value: unknown): string | undefined => {
  if (!isRecord(value)) return undefined;

  for (const key of ["command", "path", "file_path", "pattern", "name"]) {
    const arg = value[key];
    if (typeof arg === "string" && arg.trim()) {
      return arg.trim().slice(0, 120);
    }
  }

  return undefined;
};

const getToolCalls = (
  message: PiMessage,
  {
    createdAt,
    messageId,
    toolResultMap,
  }: {
    createdAt: string;
    messageId: string;
    toolResultMap: Map<string, { isError: boolean; resultAt: string; text: string }>;
  },
): SessionToolCall[] => {
  if (!Array.isArray(message.content)) return [];

  return message.content.flatMap((part, index) => {
    if (!isRecord(part) || part.type !== "toolCall") return [];
    if (typeof part.name !== "string") return [];

    const id = typeof part.id === "string" ? part.id : `${messageId}-${index}`;
    const summary = summarizeArguments(part.arguments);
    const params = getParams(part.arguments);
    const result = toolResultMap.get(id);
    return [
      {
        createdAt,
        id,
        messageId,
        name: part.name,
        ...(summary ? { summary } : {}),
        ...(params ? { params } : {}),
        ...(result ? {
          isError: result.isError,
          ...(result.isError ? { errorText: result.text.slice(0, 1000) } : {}),
          resultAt: result.resultAt,
          resultText: result.text.slice(0, 4000),
        } : {}),
      },
    ];
  });
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const getMessageText = (message: PiMessage): string => {
  if (typeof message.content === "string") {
    return message.content;
  }

  if (!Array.isArray(message.content)) {
    return "";
  }

  return message.content
    .flatMap((part) => {
      if (!isRecord(part) || part.type !== "text") {
        return [];
      }

      return typeof part.text === "string"
        ? [part.text]
        : typeof part.content === "string"
          ? [part.content]
          : [];
    })
    .join("");
};

/** Placeholder for reasoning the provider withheld. */
const REDACTED_THINKING = "[redacted by the provider\u2019s safety filter]";

/**
 * The model\u2019s reasoning for a turn, joined across blocks.
 *
 * Pi records it as `{ type: "thinking" }` content parts alongside the text and
 * tool calls (pi-ai types.d.ts), so it is already in every persisted entry —
 * getMessageText just filters it out. A redacted block carries no readable
 * text, only an opaque `thinkingSignature` the API needs for continuity, so it
 * is reported as withheld rather than dumped.
 */
export const getThinkingText = (message: PiMessage): string | undefined => {
  if (!Array.isArray(message.content)) return undefined;

  const blocks = message.content.flatMap((part) => {
    if (!isRecord(part) || part.type !== "thinking") return [];
    if (part.redacted === true) return [REDACTED_THINKING];
    return typeof part.thinking === "string" && part.thinking.trim()
      ? [part.thinking]
      : [];
  });

  return blocks.length > 0 ? blocks.join("\n\n") : undefined;
};

const isDisplayMessage = (
  message: PiMessage
): message is PiMessage & { role: "assistant" | "user" } =>
  message.role === "assistant" || message.role === "user";

/**
 * Load a session's transcript, from disk when there is one.
 *
 * Pi writes every entry to the session file as it happens, so it is complete
 * and available without a database. Postgres is the mirror, read only for
 * sessions recorded before the file became authoritative or whose file is gone.
 */
export const getTranscript = async (
  supabase: SupabaseClient<Database>,
  semlaSessionId: string
): Promise<SessionTranscript> => {
  const fromDisk = readSessionEntries(semlaSessionId);
  if (fromDisk) return buildTranscript(fromDisk);

  return getTranscriptFromDatabase(supabase, semlaSessionId);
};

const getTranscriptFromDatabase = async (
  supabase: SupabaseClient<Database>,
  semlaSessionId: string
): Promise<SessionTranscript> => {
  const { data: piSession, error: sessionError } = await supabase
    .from("pi_sessions")
    .select("id")
    .eq("semla_session_id", semlaSessionId)
    .maybeSingle();

  if (sessionError) {
    throw new Error(`Unable to load Pi session: ${sessionError.message}`);
  }

  if (!piSession) {
    return { messages: [], toolCalls: [] };
  }

  const { data: entries, error: entriesError } = await supabase
    .from("pi_session_entries")
    .select("created_at, id, payload")
    .eq("pi_session_id", piSession.id)
    .eq("event_type", "message")
    .order("created_at");

  if (entriesError) {
    throw new Error(`Unable to load Pi transcript: ${entriesError.message}`);
  }

  return buildTranscript(entries as unknown as TranscriptRow[]);
};

/** The shared transform: both sources reduce to the same row shape. */
export const buildTranscript = (entries: TranscriptRow[]): SessionTranscript => {

  // First pass: build a map of tool call ID → result info so tool calls can be
  // annotated with success/failure without a separate query.
  const toolResultMap = new Map<string, { isError: boolean; resultAt: string; text: string }>();
  for (const entry of entries) {
    const payload = entry.payload as { entry?: { message?: PiMessage; timestamp?: string } };
    const message = payload.entry?.message;
    if (!message || message.role !== "toolResult") continue;
    const callId = typeof message.toolCallId === "string" ? message.toolCallId : null;
    if (!callId) continue;
    const text = Array.isArray(message.content)
      ? (message.content as Array<unknown>)
          .filter((p): p is { type: string; text: string } =>
            isRecord(p) && p.type === "text" && typeof p.text === "string"
          )
          .map((p) => p.text)
          .join("")
      : typeof message.content === "string"
        ? message.content
        : "";
    const resultAt = payload.entry?.timestamp ?? entry.created_at;
    toolResultMap.set(callId, { isError: Boolean(message.isError), resultAt, text });
  }

  const toolCalls: SessionToolCall[] = [];

  const messages = entries.flatMap((entry) => {
    const payload = entry.payload as { entry?: { message?: PiMessage; timestamp?: string } };
    const message = payload.entry?.message;

    if (!message) {
      return [];
    }

    // payload.entry.timestamp is the actual event time set by the pi runtime.
    // entry.created_at is the Supabase insertion time, which can lag significantly
    // behind the real event time when entries are written asynchronously.
    const createdAt = payload.entry?.timestamp ?? entry.created_at;

    toolCalls.push(
      ...getToolCalls(message, { createdAt, messageId: entry.id, toolResultMap }),
    );

    if (!isDisplayMessage(message)) {
      return [];
    }

    const cost = message.usage?.cost?.total;
    const total = message.usage?.totalTokens;
    // Total context tokens sent to the model = fresh input + cache reads + cache writes.
    // Using only `usage.input` (uncached tokens) yields near-zero values that make
    // the fill bar invisible on the first turn where everything is written to cache.
    const contextTokens =
      message.usage != null
        ? (message.usage.input ?? 0) +
          (message.usage.cacheRead ?? 0) +
          (message.usage.cacheWrite ?? 0)
        : null;
    const inputTokens = contextTokens != null && contextTokens > 0 ? contextTokens : null;
    const thinking =
      message.role === "assistant" ? getThinkingText(message) : undefined;
    return [
      {
        createdAt,
        id: entry.id,
        role: message.role,
        text: getMessageText(message),
        ...(thinking ? { thinking } : {}),
        ...(message.role === "assistant" && cost != null && total != null
          ? { tokenUsage: { cost, total } }
          : {}),
        ...(message.role === "assistant" && inputTokens != null
          ? { inputTokens }
          : {}),
      },
    ];
  });

  return { messages, toolCalls };
};
