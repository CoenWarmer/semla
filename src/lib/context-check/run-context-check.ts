import {
  computeComposition,
  contextWindowUsage,
  latestInputTokens,
} from "@/lib/context-composition";
import { ensurePiAgentDirIsolated } from "@/lib/pi/runtime/agent-dir";
import type { SessionToolCall, SessionTranscriptEntry } from "@/lib/pi/transcript";
import { createAdminClient } from "@/lib/supabase-admin";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { buildCompactTranscript } from "./compact-transcript";
import { computeCorrectionRate } from "./correction-rate";
import { runInspectorLlm } from "./inspector-llm";
import type { ContextCheckResult, DimensionLevel, DimensionScore } from "./types";

export function emptyContextCheckResult(): ContextCheckResult {
  return {
    checkedAt: new Date().toISOString(),
    dimensions: {
      composition: {
        assistantFraction: 0,
        contextWindowFraction: null,
        summary: "No messages yet.",
        systemPromptFraction: 0,
        toolResultFraction: 0,
        userFraction: 0,
      },
      correctionRate: {
        correctionCount: 0,
        level: "good",
        rate: 0,
        summary: "No messages yet.",
        userTurns: 0,
      },
      goalDrift: { level: "good", summary: "No messages yet." },
      staleness: { level: "good", summary: "No messages yet." },
      supersessionDepth: { level: "good", summary: "No messages yet." },
    },
    interventions: [],
    quality: "good",
    summary: "No messages to assess.",
    turnCount: 0,
  };
}

export async function runContextCheck({
  goal,
  messages,
  semlaSessionId,
  systemPromptChars,
  toolCalls,
}: {
  goal: string | null;
  messages: SessionTranscriptEntry[];
  semlaSessionId: string;
  systemPromptChars: number;
  toolCalls: SessionToolCall[];
}): Promise<ContextCheckResult> {
  if (messages.length === 0) {
    return emptyContextCheckResult();
  }

  // Algorithmic metrics
  const correctionMetrics = computeCorrectionRate(messages);
  const compositionMetrics = computeComposition(messages, toolCalls, systemPromptChars);

  // Resolve model for this session
  const admin = createAdminClient();
  const { data: piSession } = await admin
    .from("pi_sessions")
    .select("model_id, model_provider")
    .eq("semla_session_id", semlaSessionId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let llmOutput: Awaited<ReturnType<typeof runInspectorLlm>> = null;
  let contextWindowFraction: number | null = null;

  if (piSession?.model_id && piSession?.model_provider) {
    // Defensive: see ensurePiAgentDirIsolated()'s docblock — a process where
    // instrumentation.ts's register() never ran would otherwise resolve
    // ModelRuntime against the host's ~/.pi/agent instead of Semla's own.
    ensurePiAgentDirIsolated();
    const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
    const apiKey = process.env.PI_MODEL_API_KEY;
    if (apiKey) {
      await modelRuntime.setRuntimeApiKey(piSession.model_provider, apiKey);
    }
    const model = modelRuntime.getModel(piSession.model_provider, piSession.model_id);

    if (model) {
      contextWindowFraction = contextWindowUsage(
        latestInputTokens(messages),
        compositionMetrics.totalChars,
        model.contextWindow,
      ).contextWindowFraction;

      const compactTranscript = buildCompactTranscript(messages);
      llmOutput = await runInspectorLlm(modelRuntime, model, {
        compactTranscript,
        compositionSummary: compositionMetrics.summary,
        correctionSummary: correctionMetrics.summary,
        goal,
        turnCount: messages.length,
      });
    }
  }

  // Fallback LLM dimensions when the inspector call failed
  const supersessionDepth: DimensionScore = llmOutput?.supersessionDepth ?? {
    level: "good",
    summary: "Unable to assess — inspector call failed.",
  };
  const staleness: DimensionScore = llmOutput?.staleness ?? {
    level: "good",
    summary: "Unable to assess — inspector call failed.",
  };
  const goalDrift: DimensionScore = llmOutput?.goalDrift ?? {
    level: "good",
    summary: goal ? "Unable to assess." : "No goal set.",
  };

  // Overall quality = worst of all scored dimensions (composition is informational only)
  const levels: DimensionLevel[] = [
    correctionMetrics.level,
    supersessionDepth.level,
    staleness.level,
    goalDrift.level,
    ...(llmOutput?.quality ? [llmOutput.quality] : []),
  ];
  const quality: DimensionLevel = levels.includes("degraded")
    ? "degraded"
    : levels.includes("warning")
      ? "warning"
      : "good";

  const summary = llmOutput?.summary ?? (
    quality === "good"
      ? "Context window looks healthy."
      : quality === "warning"
        ? "Some signs of context degradation — consider an intervention."
        : "Context window is significantly degraded."
  );

  return {
    checkedAt: new Date().toISOString(),
    dimensions: {
      composition: {
        assistantFraction: compositionMetrics.assistantFraction,
        contextWindowFraction,
        summary: compositionMetrics.summary,
        systemPromptFraction: compositionMetrics.systemPromptFraction,
        toolResultFraction: compositionMetrics.toolResultFraction,
        userFraction: compositionMetrics.userFraction,
      },
      correctionRate: {
        correctionCount: correctionMetrics.correctionCount,
        level: correctionMetrics.level,
        rate: correctionMetrics.rate,
        summary: correctionMetrics.summary,
        userTurns: correctionMetrics.userTurns,
      },
      goalDrift,
      staleness,
      supersessionDepth,
    },
    interventions: llmOutput?.interventions ?? [],
    quality,
    summary,
    turnCount: messages.length,
  };
}
