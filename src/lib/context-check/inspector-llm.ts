import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import type { DimensionLevel } from "./types";

// ---- LLM inspector pass ------------------------------------------------

type InspectorOutput = {
  goalDrift: { level: DimensionLevel; summary: string };
  interventions: Array<{ action: "restart" | "restate-goal" | "summarize"; label: string }>;
  quality: DimensionLevel;
  staleness: { level: DimensionLevel; summary: string };
  summary: string;
  supersessionDepth: { level: DimensionLevel; summary: string };
};

const INSPECTOR_SYSTEM_PROMPT = `You are an independent context quality inspector for an AI coding assistant session. You run in a completely separate context and have no influence on the main session.

Your job: assess three specific dimensions of context health and return a single JSON object. Be precise and evidence-based. Do not make up issues that are not visible in the transcript.

Return ONLY valid JSON matching this exact schema:
{
  "quality": "good" | "warning" | "degraded",
  "summary": "<one sentence overall>",
  "supersessionDepth": { "level": "good" | "warning" | "degraded", "summary": "<one sentence>" },
  "staleness": { "level": "good" | "warning" | "degraded", "summary": "<one sentence>" },
  "goalDrift": { "level": "good" | "warning" | "degraded", "summary": "<one sentence>" },
  "interventions": [{ "action": "restart" | "restate-goal" | "summarize", "label": "<2-4 word button label>" }]
}

Dimension definitions:
- supersessionDepth: How many facts, decisions, or instructions were stated early and then contradicted or overwritten — while the original version is still visible in context? (0 = good, 1-2 = warning, 3+ = degraded)
- staleness: How much of the early context (first third of turns) sets up information, constraints, or decisions that are never referenced later? Stale dead weight dilutes attention. (none = good, some = warning, pervasive = degraded)
- goalDrift: How far has the current conversation topic drifted from the original goal or the user's first intent? (on-track = good, moderate drift = warning, off the rails = degraded)

For interventions, only include ones that are actually warranted. Maximum 3. "restart" = start a fresh session, "restate-goal" = user should restate the session goal, "summarize" = ask the agent to write a handoff summary.`;

export async function runInspectorLlm(
  modelRuntime: ModelRuntime,
  model: Parameters<ModelRuntime["completeSimple"]>[0],
  {
    compactTranscript,
    compositionSummary,
    correctionSummary,
    goal,
    turnCount,
  }: {
    compactTranscript: string;
    compositionSummary: string;
    correctionSummary: string;
    goal: string | null;
    turnCount: number;
  },
): Promise<InspectorOutput | null> {
  const userPrompt = [
    goal ? `SESSION GOAL: ${goal}` : "SESSION GOAL: (not set)",
    "",
    "PRE-COMPUTED METRICS:",
    `- Total turns: ${turnCount}`,
    `- Correction rate: ${correctionSummary}`,
    `- Composition: ${compositionSummary}`,
    "",
    "TRANSCRIPT (compressed, each message ≤400 chars):",
    compactTranscript,
  ].join("\n");

  const result = await modelRuntime.completeSimple(model, {
    // oxlint-disable-next-line typescript/no-explicit-any
    messages: [{ content: [{ text: userPrompt, type: "text" }], role: "user", timestamp: 0 }] as any,
    systemPrompt: INSPECTOR_SYSTEM_PROMPT,
  });

  const text = result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    return JSON.parse(jsonMatch[0]) as InspectorOutput;
  } catch {
    return null;
  }
}
