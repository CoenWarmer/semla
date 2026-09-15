import type { SessionTranscriptEntry } from "@/lib/pi/transcript";

import type { DimensionLevel } from "./types";

// ---- Algorithmic helpers ------------------------------------------------

const CORRECTION_SIGNALS = [
  "no,", "no.", "wait,", "wait.", "wrong", "incorrect", "not right",
  "that's not", "you're wrong", "you misunderstood", "actually,", "actually.",
  "stop,", "stop.", "undo", "revert", "i said", "i meant", "i told you",
  "that's the opposite", "go back", "you forgot", "you missed",
];

export function computeCorrectionRate(messages: SessionTranscriptEntry[]) {
  const userMessages = messages.filter((m) => m.role === "user");
  const correctionCount = userMessages.filter((m) =>
    CORRECTION_SIGNALS.some((sig) => m.text.toLowerCase().includes(sig))
  ).length;
  const rate = userMessages.length > 0 ? correctionCount / userMessages.length : 0;
  const level: DimensionLevel =
    rate >= 0.3 ? "degraded" : rate >= 0.15 ? "warning" : "good";
  const summary =
    correctionCount === 0
      ? "No correction signals detected."
      : `${correctionCount} correction${correctionCount === 1 ? "" : "s"} in ${userMessages.length} user turns (${Math.round(rate * 100)}%).`;
  return { correctionCount, level, rate, summary, userTurns: userMessages.length };
}
