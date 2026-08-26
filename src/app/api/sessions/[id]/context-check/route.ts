import { handleRouteError } from "@/lib/api-helpers";
import { requireSessionOwner } from "@/lib/session-auth";
import { getTranscript } from "@/lib/pi/transcript";
import { createAdminClient } from "@/lib/supabase-admin";
import { createClient } from "@/lib/supabase/server";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { SessionTranscriptEntry, SessionToolCall } from "@/lib/pi/transcript";

export const runtime = "nodejs";

export type DimensionLevel = "good" | "warning" | "degraded";

export type DimensionScore = {
  level: DimensionLevel;
  summary: string;
};

export type ContextCheckResult = {
  checkedAt: string;
  dimensions: {
    composition: DimensionScore & {
      assistantFraction: number;
      toolResultFraction: number;
      userFraction: number;
    };
    correctionRate: DimensionScore & {
      correctionCount: number;
      rate: number;
      userTurns: number;
    };
    goalDrift: DimensionScore;
    staleness: DimensionScore;
    supersessionDepth: DimensionScore;
  };
  interventions: Array<{ action: "restart" | "restate-goal" | "summarize"; label: string }>;
  quality: DimensionLevel;
  summary: string;
  turnCount: number;
};

// ---- Algorithmic helpers ------------------------------------------------

const CORRECTION_SIGNALS = [
  "no,", "no.", "wait,", "wait.", "wrong", "incorrect", "not right",
  "that's not", "you're wrong", "you misunderstood", "actually,", "actually.",
  "stop,", "stop.", "undo", "revert", "i said", "i meant", "i told you",
  "that's the opposite", "go back", "you forgot", "you missed",
];

function computeCorrectionRate(messages: SessionTranscriptEntry[]) {
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

function computeComposition(
  messages: SessionTranscriptEntry[],
  toolCalls: SessionToolCall[],
) {
  const userChars = messages
    .filter((m) => m.role === "user")
    .reduce((sum, m) => sum + m.text.length, 0);
  const assistantChars = messages
    .filter((m) => m.role === "assistant")
    .reduce((sum, m) => sum + m.text.length, 0);
  const toolResultChars = toolCalls.reduce(
    (sum, t) => sum + (t.resultText?.length ?? 0),
    0,
  );
  const total = userChars + assistantChars + toolResultChars || 1;
  const userFraction = userChars / total;
  const assistantFraction = assistantChars / total;
  const toolResultFraction = toolResultChars / total;
  const level: DimensionLevel =
    toolResultFraction >= 0.55 ? "degraded" : toolResultFraction >= 0.35 ? "warning" : "good";
  const pct = Math.round(toolResultFraction * 100);
  const summary =
    pct < 20
      ? `Healthy mix — tool results occupy ${pct}% of context.`
      : pct < 35
        ? `Tool results are ${pct}% of context — manageable.`
        : `Tool results dominate at ${pct}% of context, crowding out dialogue.`;
  return { assistantFraction, level, summary, toolResultFraction, userFraction };
}

// ---- Compact transcript for the inspector LLM --------------------------

function buildCompactTranscript(messages: SessionTranscriptEntry[]): string {
  return messages
    .map((m, i) => {
      const role = m.role === "user" ? "User" : "Assistant";
      const text = m.text.slice(0, 400);
      return `[${i + 1}] ${role}: ${text}${m.text.length > 400 ? "…" : ""}`;
    })
    .join("\n");
}

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

async function runInspectorLlm(
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

// ---- Route handler ------------------------------------------------------

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    await requireSessionOwner(id);
    const supabase = await createClient();
    const { messages, toolCalls } = await getTranscript(supabase, id);

    if (messages.length === 0) {
      return Response.json({
        checkedAt: new Date().toISOString(),
        dimensions: {
          composition: { assistantFraction: 0, level: "good", summary: "No messages yet.", toolResultFraction: 0, userFraction: 0 },
          correctionRate: { correctionCount: 0, level: "good", rate: 0, summary: "No messages yet.", userTurns: 0 },
          goalDrift: { level: "good", summary: "No messages yet." },
          staleness: { level: "good", summary: "No messages yet." },
          supersessionDepth: { level: "good", summary: "No messages yet." },
        },
        interventions: [],
        quality: "good",
        summary: "No messages to assess.",
        turnCount: 0,
      } satisfies ContextCheckResult);
    }

    // Fetch goal from sessions table
    const { data: sessionRow } = await supabase
      .from("sessions")
      .select("goal")
      .eq("id", id)
      .maybeSingle();
    const goal = sessionRow?.goal ?? null;

    // Algorithmic metrics
    const correctionMetrics = computeCorrectionRate(messages);
    const compositionMetrics = computeComposition(messages, toolCalls);

    // Resolve model for this session
    const admin = createAdminClient();
    const { data: piSession } = await admin
      .from("pi_sessions")
      .select("model_id, model_provider")
      .eq("semla_session_id", id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    let llmOutput: InspectorOutput | null = null;

    if (piSession?.model_id && piSession?.model_provider) {
      const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
      const apiKey = process.env.PI_MODEL_API_KEY;
      if (apiKey) {
        await modelRuntime.setRuntimeApiKey(piSession.model_provider, apiKey);
      }
      const model = modelRuntime.getModel(piSession.model_provider, piSession.model_id);

      if (model) {
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

    // Overall quality = worst of all dimensions
    const levels: DimensionLevel[] = [
      correctionMetrics.level,
      compositionMetrics.level,
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

    return Response.json({
      checkedAt: new Date().toISOString(),
      dimensions: {
        composition: {
          assistantFraction: compositionMetrics.assistantFraction,
          level: compositionMetrics.level,
          summary: compositionMetrics.summary,
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
    } satisfies ContextCheckResult);
  } catch (error) {
    return handleRouteError(error, "Unable to run context check.");
  }
}
