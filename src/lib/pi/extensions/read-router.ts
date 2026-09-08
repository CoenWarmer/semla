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

/**
 * Why this returns a reason rather than just null.
 *
 * `complete()` does not throw when a provider has no credentials. It resolves
 * — in about a millisecond — with a well-formed AssistantMessage carrying
 * `stopReason: "error"`, `errorMessage: "Provider is not configured: x"`, no
 * content and zero usage. A `try/catch` around it never fires, and joining
 * that empty content yields `""`, which is indistinguishable from a model that
 * genuinely had nothing to say.
 *
 * That is measured, not theoretical: it is why this extension compressed 0 of
 * 7 eligible results in the session it was written in, with no log line. The
 * default model was `anthropic/...` on a host holding only an `openrouter`
 * key, `find()` returned the model because the *catalogue* has it, and every
 * compression then failed open and silently.
 *
 * So the failure has to be *named* and reported. Callers surface it once per
 * session; `stopReason` on the response is the only trustworthy signal, since
 * `hasConfiguredAuth()` returns false even for a provider that completes
 * successfully.
 */
type ModelOutcome =
  | { ok: true; summary: string }
  | { ok: false; reason: string };

async function callModel(
  rawText: string,
  toolName: string,
  ctx: ExtensionContext,
  provider: string,
  modelId: string,
): Promise<ModelOutcome> {
  const model = ctx.modelRegistry.find(provider, modelId);
  if (!model) {
    return {
      ok: false,
      reason: `no model "${provider}/${modelId}" in the catalogue`,
    };
  }

  let response;
  try {
    response = await ctx.modelRegistry.complete(model, {
      systemPrompt: COMPRESSION_SYSTEM_PROMPT,
      messages: [
        {
          role: "user" as const,
          content: `Summarise this ${toolName} output:\n\n\`\`\`\n${rawText}\n\`\`\``,
          timestamp: Date.now(),
        },
      ],
    });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }

  // The check the original omitted. An unconfigured provider, a rate limit and
  // an aborted request all arrive here rather than as a thrown error.
  if (response.stopReason === "error") {
    return { ok: false, reason: response.errorMessage ?? "model returned an error" };
  }

  const text = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text" && "text" in c)
    .map((c) => c.text)
    .join("");

  if (!text) return { ok: false, reason: "model returned no text" };
  return { ok: true, summary: text };
}

function parseModel(modelSpec: string): { provider: string; modelId: string } {
  const slash = modelSpec.indexOf("/");
  if (slash === -1) return { provider: modelSpec, modelId: modelSpec };
  return { provider: modelSpec.slice(0, slash), modelId: modelSpec.slice(slash + 1) };
}

/**
 * Which model to summarise with, preferring one the host can actually reach.
 *
 * An explicit `readRouterModel` is obeyed as given — a configured value is a
 * decision, and silently substituting something else would be worse than
 * failing. Otherwise the session's own provider wins over the hardcoded
 * default: whatever model is driving the session is by definition configured,
 * so a Haiku on that provider is reachable where `anthropic/...` may not be.
 *
 * Only the provider is borrowed, never the session's model id — that is the
 * frontier model, and summarising cheap output with it would cost more than
 * the context it saves.
 *
 * Two exclusions here were found by running this against a live catalogue
 * rather than reasoned out. A reasoning model is rejected because pi sends
 * `reasoning.effort: "none"` for a plain completion and OpenAI's o-series
 * answers 400 `unsupported_value` — a summariser that cannot be called is
 * worse than the default, since it fails on every result. And the name test is
 * anchored: an unanchored `/mini/` matched `minimax/minimax-m1`, a different
 * vendor's frontier model, which is the opposite of choosing something cheap.
 */
function chooseModel(
  settings: { readRouterModel?: string },
  ctx: ExtensionContext,
): { provider: string; modelId: string } {
  if (settings.readRouterModel) return parseModel(settings.readRouterModel);

  const fallback = parseModel(DEFAULT_MODEL);
  const sessionProvider = ctx.model?.provider;
  if (!sessionProvider || sessionProvider === fallback.provider) return fallback;

  // A same-provider Haiku, addressed as that provider spells it. Gateways
  // prefix the vendor (openrouter: "anthropic/claude-haiku-4.5"), so the id is
  // matched rather than constructed.
  const candidate = ctx.modelRegistry
    .getAll()
    .filter((model) => model.provider === sessionProvider)
    // `-mini`/`-flash` as a suffix or path segment, never as a substring of a
    // vendor's name. Haiku is matched loosely because Anthropic only uses it
    // for the cheap tier.
    .filter((model) => /haiku|[-/](?:flash|mini)\b/i.test(model.id))
    // A batch endpoint does not answer synchronously; `~` marks an alias.
    .filter((model) => !/batch|^~/.test(model.id))
    // Reasoning models reject the `reasoning.effort: "none"` pi sends here.
    .filter((model) => !model.reasoning)
    .sort((a, b) => a.id.length - b.id.length)[0];

  return candidate
    ? { modelId: candidate.id, provider: sessionProvider }
    : fallback;
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

  /**
   * A compressor that never compresses must say so, once.
   *
   * This extension fails open by design: every failure path hands the raw
   * result through, so a broken summariser costs context rather than
   * correctness. The hazard is that this is *invisible* — the tuned
   * thresholds, the spans and the shutdown line all read identically whether
   * the model is unreachable or merely never triggered. One warning on the
   * first failure is what separates the two, and `failures` is what keeps it
   * from repeating on every tool call.
   */
  let failures = 0;
  const reportFailure = (reason: string) => {
    failures++;
    if (failures > 1) return;
    console.warn(
      `[read-router] compression disabled for this session: ${reason}. ` +
        "Tool results are passing through uncompressed.",
    );
  };

  pi.on(
    "tool_result",
    async (event: ToolResultEvent, ctx: ExtensionContext) => {
      const settings = loadWorkflowSettings({ cwd: ctx.cwd });
      if (settings.readRouterEnabled === false) return;

      const rawText = extractText(event.content);
      const thresholdLines = settings.readRouterThresholdLines ?? 300;
      const thresholdChars = settings.readRouterThresholdChars ?? 3000;

      if (!shouldCompress(event.toolName, event.isError, rawText, thresholdLines, thresholdChars)) return;

      const { provider, modelId } = chooseModel(settings, ctx);
      const modelSpec = `${provider}/${modelId}`;

      const key = contentHash(rawText);
      let summary = cache.get(key);
      if (!summary) {
        const outcome = await callModel(rawText, event.toolName, ctx, provider, modelId);
        if (!outcome.ok) {
          reportFailure(outcome.reason);
          return;
        }
        summary = outcome.summary;
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
      const { provider, modelId } = chooseModel(settings, ctx);

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
            const outcome = await callModel(rawText, tm.toolName, ctx, provider, modelId);
            if (!outcome.ok) {
              reportFailure(outcome.reason);
              result.push(msg);
              continue;
            }
            summary = outcome.summary;
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
    // A session that compressed nothing but tried is the case worth reporting:
    // silence here is what made the original failure take a live investigation
    // to find.
    if (stats.count === 0) {
      if (failures > 0) {
        console.warn(
          `[read-router] 0 compressions: ${failures} attempt(s) failed. ` +
            "See the earlier warning for the reason.",
        );
      }
      return;
    }
    const pct =
      stats.originalChars > 0
        ? Math.round((1 - stats.compressedChars / stats.originalChars) * 100)
        : 0;
    console.info(
      `[read-router] ${stats.count} compression(s): ${stats.originalChars} → ${stats.compressedChars} chars (${pct}% reduction)` +
        (failures > 0 ? `; ${failures} attempt(s) failed` : ""),
    );
  });
}
