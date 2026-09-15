import type { SessionTranscriptEntry } from "@/lib/pi/transcript";

// ---- Compact transcript for the inspector LLM --------------------------

export function buildCompactTranscript(messages: SessionTranscriptEntry[]): string {
  return messages
    .map((m, i) => {
      const role = m.role === "user" ? "User" : "Assistant";
      const text = m.text.slice(0, 400);
      return `[${i + 1}] ${role}: ${text}${m.text.length > 400 ? "…" : ""}`;
    })
    .join("\n");
}
