import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/types/database.types";

type PiMessage = {
  content: unknown;
  role: string;
};

export type SessionTranscriptEntry = {
  createdAt: string;
  id: string;
  role: "assistant" | "user";
  text: string;
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

const isDisplayMessage = (
  message: PiMessage
): message is PiMessage & { role: "assistant" | "user" } =>
  message.role === "assistant" || message.role === "user";

export const getTranscript = async (
  supabase: SupabaseClient<Database>,
  semlaSessionId: string
): Promise<SessionTranscriptEntry[]> => {
  const { data: piSession, error: sessionError } = await supabase
    .from("pi_sessions")
    .select("id")
    .eq("semla_session_id", semlaSessionId)
    .maybeSingle();

  if (sessionError) {
    throw new Error(`Unable to load Pi session: ${sessionError.message}`);
  }

  if (!piSession) {
    return [];
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

  return entries.flatMap((entry) => {
    const payload = entry.payload as { entry?: { message?: PiMessage } };
    const message = payload.entry?.message;

    if (!message || !isDisplayMessage(message)) {
      return [];
    }

    return [
      {
        createdAt: entry.created_at,
        id: entry.id,
        role: message.role,
        text: getMessageText(message),
      },
    ];
  });
};
