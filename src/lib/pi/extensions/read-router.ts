/**
 * Intercepts large tool results before they enter the frontier model's context
 * and replaces them with a cheap-model summary. Transparent to the model —
 * it sees only the compressed result, never the raw output.
 *
 * Phase 1: tool_result hook — threshold-gated, synchronous with the tool call.
 * Phase 2: context hook — retroactive compression of pre-existing history,
 *           content-hash cached, 2 s latency guard so a slow model never delays a turn.
 * Phase 3: reads readRouterEnabled / readRouterModel / threshold settings from WorkflowSettings.
 * Phase 4: emits read_router.compress spans and a session_shutdown summary.
 */

import { createHash } from "node:crypto";

import type {
  ContextEvent,
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";

import { getSpanSink } from "@/lib/pi/telemetry/sink-registry";
import { loadWorkflowSettings } from "./dynamic-workflows/src/workflow-settings";

const DEFAULT_MODEL = "anthropic/claude-haiku-4-5-20251001";

// Lines at which grep/find output is compressed (matches are one per line).
const GREP_FIND_LINE_THRESHOLD = 40;
// Lines at which ls output is compressed.
const LS_LINE_THRESHOLD = 80;

const COMPRESSION_SYSTEM_PROMPT =
  "You are a precise code analyst. Given file content or command output, produce a concise factual summary for an AI coding agent. Return only facts — no preamble, no affirmations, no repetition of the question. " +
  "For code files: state the file's purpose (one sentence), list public exports with signatures, and note non-obvious invariants. " +
  "For command output: extract only the values and lines relevant to the apparent task. " +
  "Aim for 20% of the original size. Use terse prose or bullet points.";

type Stats = {
  count: number;
  originalChars: number;
  compressedChars: number;
};

function extractText(content: Array<unknown>): string {
  return (content as Array<{ type: string; text?: string }>)
    .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}

function lineCount(text: string): number {
  return text ? text.split("\n").length : 0;
}

function shouldCompress(
  toolName: string,
  isError: boolean,
  rawText: string,
  thresholdLines: number,
  thresholdChars: number,
): boolean {
  if (isError) return false;
  // edit and write results need exact content — never compress
  if (toolName === "edit" || toolName === "write") return false;
  // already compressed by a previous call
  if (rawText.startsWith("[Compressed:")) return false;

  switch (toolName) {
    case "read":
      return lineCount(rawText) > thresholdLines;
    case "bash":
      return rawText.length > thresholdChars;
    case "grep":
      return lineCount(rawText) > GREP_FIND_LINE_THRESHOLD;
    case "find":
      return lineCount(rawText) > GREP_FIND_LINE_THRESHOLD;
    case "ls":
      return lineCount(rawText) > LS_LINE_THRESHOLD;
    default:
      return false;
  }
}

async function callModel(
  rawText: string,
  toolName: string,
  ctx: ExtensionContext,
  provider: string,
  modelId: string,
): Promise<string | null> {
  const model = ctx.modelRegistry.find(provider, modelId);
  if (!model) return null;
  try {
    const response = await ctx.modelRegistry.complete(model, {
      systemPrompt: COMPRESSION_SYSTEM_PROMPT,
      messages: [
        {
          role: "user" as const,
          content: `Summarise this ${toolName} output:\n\n\`\`\`\n${rawText}\n\`\`\``,
          timestamp: Date.now(),
        },
      ],
    });
    const text = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text" && "text" in c)
      .map((c) => c.text)
      .join("");
    return text || null;
  } catch {
    return null;
  }
}

function parseModel(modelSpec: string): { provider: string; modelId: string } {
  const slash = modelSpec.indexOf("/");
  if (slash === -1) return { provider: modelSpec, modelId: modelSpec };
  return { provider: modelSpec.slice(0, slash), modelId: modelSpec.slice(slash + 1) };
}

function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function buildCompressed(rawText: string, summary: string): string {
  return `[Compressed: ${rawText.length} chars → via read-router]\n\n${summary}`;
}

export default function readRouterExtension(pi: ExtensionAPI) {
  // Shared across both hooks: avoids re-summarising the same content twice.
  const cache = new Map<string, string>(); // sha256(raw)[0:16] → summary
  const stats: Stats = { count: 0, originalChars: 0, compressedChars: 0 };

  pi.on(
    "tool_result",
    async (event: ToolResultEvent, ctx: ExtensionContext) => {
      const settings = loadWorkflowSettings({ cwd: ctx.cwd });
      if (settings.readRouterEnabled === false) return;

      const rawText = extractText(event.content);
      const thresholdLines = settings.readRouterThresholdLines ?? 300;
      const thresholdChars = settings.readRouterThresholdChars ?? 3000;

      if (!shouldCompress(event.toolName, event.isError, rawText, thresholdLines, thresholdChars)) return;

      const modelSpec = settings.readRouterModel ?? DEFAULT_MODEL;
      const { provider, modelId } = parseModel(modelSpec);

      const key = contentHash(rawText);
      let summary = cache.get(key);
      if (!summary) {
        summary = (await callModel(rawText, event.toolName, ctx, provider, modelId)) ?? undefined;
        if (!summary) return;
        cache.set(key, summary);
      }

      const compressed = buildCompressed(rawText, summary);

      stats.count++;
      stats.originalChars += rawText.length;
      stats.compressedChars += compressed.length;

      const sink = getSpanSink(ctx.sessionManager.getSessionId());
      if (sink) {
        const span = sink.openSpan({ name: "read_router.compress" });
        span.setAttributes({
          tool: event.toolName,
          originalChars: rawText.length,
          compressedChars: compressed.length,
          ratio: rawText.length > 0 ? compressed.length / rawText.length : 1,
          model: modelSpec,
        });
        span.close();
      }

      return { content: [{ type: "text", text: compressed }] };
    },
  );

  pi.on(
    "context",
    async (event: ContextEvent, ctx: ExtensionContext) => {
      const settings = loadWorkflowSettings({ cwd: ctx.cwd });
      if (settings.readRouterEnabled === false) return;

      const thresholdLines = settings.readRouterThresholdLines ?? 300;
      const thresholdChars = settings.readRouterThresholdChars ?? 3000;
      const modelSpec = settings.readRouterModel ?? DEFAULT_MODEL;
      const { provider, modelId } = parseModel(modelSpec);

      let anyChanged = false;

      const compress = async (): Promise<typeof event.messages> => {
        const result: typeof event.messages = [];
        for (const msg of event.messages) {
          if (msg.role !== "toolResult") {
            result.push(msg);
            continue;
          }
          // Narrow to the shape we need — AgentMessage includes ToolResultMessage
          const tm = msg as unknown as {
            role: "toolResult";
            toolName: string;
            isError: boolean;
            content: Array<unknown>;
          };
          const rawText = extractText(tm.content);
          if (!shouldCompress(tm.toolName, tm.isError, rawText, thresholdLines, thresholdChars)) {
            result.push(msg);
            continue;
          }
          const key = contentHash(rawText);
          let summary = cache.get(key);
          if (!summary) {
            summary = (await callModel(rawText, tm.toolName, ctx, provider, modelId)) ?? undefined;
            if (!summary) {
              result.push(msg);
              continue;
            }
            cache.set(key, summary);
          }
          const compressed = buildCompressed(rawText, summary);
          anyChanged = true;
          stats.count++;
          stats.originalChars += rawText.length;
          stats.compressedChars += compressed.length;
          result.push({
            ...msg,
            content: [{ type: "text" as const, text: compressed }],
          } as (typeof event.messages)[number]);
        }
        return result;
      };

      const winner = await Promise.race([
        compress(),
        new Promise<null>((resolve) => {
          setTimeout(() => resolve(null), 2000);
        }),
      ]);

      if (!winner || !anyChanged) return;
      return { messages: winner };
    },
  );

  pi.on("session_shutdown", () => {
    if (stats.count === 0) return;
    const pct =
      stats.originalChars > 0
        ? Math.round((1 - stats.compressedChars / stats.originalChars) * 100)
        : 0;
    console.info(
      `[read-router] ${stats.count} compression(s): ${stats.originalChars} → ${stats.compressedChars} chars (${pct}% reduction)`,
    );
  });
}
