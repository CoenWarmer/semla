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
// Matches kept verbatim when truncating search output. Enough to be useful,
// few enough to be worth doing — a 962-match `rg` is 100 KB of context.
const SEARCH_KEEP_LINES = 40;

/**
 * Three of the instructions below are corrections to observed failures, not
 * general good advice, and are worth keeping for that reason.
 *
 * The prompt used to say "extract only the values and lines relevant to the
 * apparent task" for command output. The summariser cannot see the task — it
 * receives one tool result and nothing else — so "apparent" invited it to
 * invent one. Given `rg -n "export" src/lib/pi`, whose 60 matches spanned 11
 * files, it inferred "summarise a TypeScript file", described the output as a
 * single unnamed file, dropped every `file:line` prefix, and attributed
 * symbols from several files to one. The prefixes are the entire point of
 * `rg -n`, and the result was wrong rather than merely lossy.
 *
 * So: the task is no longer guessed at (callModel is given the actual command
 * or path), and the model is told to describe an unfamiliar shape literally
 * rather than forcing it into the code-file shape.
 *
 * Instructing it to preserve `file:line` prefixes was tried first and does not
 * work. Told explicitly that locations are the payload, never to summarise
 * them into prose and to drop matched source before dropping a location, the
 * summariser still returned 0 of 14 filenames and no line numbers at all: it
 * reliably flattens matches into a symbol list, because that is what a wall of
 * `path:line:text` looks like to it. Search output is therefore truncated
 * rather than summarised — see `truncateSearchOutput`. The lesson generalises:
 * a prompt cannot be relied on to preserve structure the model does not value.
 */
const COMPRESSION_SYSTEM_PROMPT =
  "You are a precise code analyst. Given file content or command output, produce a concise factual summary for an AI coding agent. Return only facts — no preamble, no affirmations, no repetition of the question. " +
  "Never invent, infer, or generalise beyond what the input states. If the input's structure is unclear, describe it literally rather than fitting it to a familiar shape. " +
  "For file content: state the purpose (one sentence), list public exports with signatures, and note non-obvious invariants. " +
  "For command output: report the values, paths, and identifiers it contains. Never describe multi-file output as though it came from one file, and never attribute a symbol to a file the input did not name. " +
  "Aim for 20% of the original size, but correctness outranks the target: return the input unchanged rather than lose a path, a line number, or an identifier. " +
  "Use terse prose or bullet points.";

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

/** `path:line:` or `path:line:col:`, the shape rg, grep -n and ripgrep emit. */
const MATCH_LINE = /^[^\s:][^:]*:\d+:/;

/**
 * Whether output is a list of file locations rather than prose.
 *
 * Decided from the *text*, not the tool name, because `grep` reaches this
 * extension as a `bash` result far more often than as a `grep` one — the agent
 * types `rg -n …` into a shell. A tool-name check would have missed the exact
 * case that exposed this.
 *
 * A simple majority is enough: ripgrep interleaves blank separators and
 * `--context` lines, so requiring every line to match would reject real search
 * output, while prose that is more than half `path:line:` is not prose.
 */
function isSearchOutput(rawText: string): boolean {
  const lines = rawText.split("\n").filter((line) => line.trim());
  if (lines.length < 2) return false;
  const matches = lines.filter((line) => MATCH_LINE.test(line)).length;
  return matches >= lines.length / 2;
}

/**
 * Keep the head of a match list verbatim and say what was dropped.
 *
 * Truncation rather than summarisation, because for search output the
 * locations *are* the payload: a `path:line` the agent can jump to is worth
 * more than a description of what was found there, and the model will not
 * preserve them (see COMPRESSION_SYSTEM_PROMPT). Head rather than a sample, so
 * the kept lines stay in file order and the agent can pick up where the list
 * stops.
 *
 * The tail note is load-bearing: silently dropping matches would let an agent
 * conclude a symbol has no other references.
 */
function truncateSearchOutput(rawText: string, keepLines: number): string {
  const lines = rawText.split("\n");
  if (lines.length <= keepLines) return rawText;
  const dropped = lines.length - keepLines;
  return (
    `[Compressed: ${rawText.length} chars → via read-router]\n\n` +
    `${lines.slice(0, keepLines).join("\n")}\n` +
    `… ${dropped} more match(es) not shown. Re-run with a narrower pattern or a \`| tail\` to see them.`
  );
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

/**
 * What the tool was actually asked to do, for the summariser's benefit.
 *
 * `event.input` holds the command or the path, and withholding it was what
 * forced the model to guess the task from the output alone. A command is far
 * more informative than the output it produced: `rg -n` says "these are
 * locations" in a way that a wall of `path:line:text` evidently does not.
 *
 * Truncated because a heredoc or a long pipeline can be arbitrarily large, and
 * this is context for the summary, not part of it.
 */
function describeInvocation(toolName: string, input: Record<string, unknown>): string {
  const command = input.command ?? input.cmd;
  if (typeof command === "string") {
    const oneLine = command.replace(/\s+/g, " ").trim();
    return `\`${oneLine.length > 300 ? `${oneLine.slice(0, 300)}…` : oneLine}\``;
  }
  const path = input.path ?? input.file ?? input.pattern;
  if (typeof path === "string") return `\`${toolName} ${path}\``;
  return `\`${toolName}\``;
}

async function callModel(
  rawText: string,
  toolName: string,
  input: Record<string, unknown>,
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
          content:
            `The agent ran ${describeInvocation(toolName, input)} and received the output below. ` +
            `Summarise it for the agent.\n\n\`\`\`\n${rawText}\n\`\`\``,
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
  /**
   * Stats and span for one compression, however it was produced.
   *
   * `mode` distinguishes a model summary from a truncation in telemetry, so a
   * session's spans show which path ran rather than implying every saving came
   * from the model.
   */
  const recordCompression = (
    rawText: string,
    compressed: string,
    toolName: string,
    mode: string,
    ctx: ExtensionContext,
  ) => {
    stats.count++;
    stats.originalChars += rawText.length;
    stats.compressedChars += compressed.length;

    const sink = getSpanSink(ctx.sessionManager.getSessionId());
    if (!sink) return;
    const span = sink.openSpan({ name: "read_router.compress" });
    span.setAttributes({
      compressedChars: compressed.length,
      model: mode,
      originalChars: rawText.length,
      ratio: rawText.length > 0 ? compressed.length / rawText.length : 1,
      tool: toolName,
    });
    span.close();
  };

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

      // Search output bypasses the model entirely: no cost, no latency, and
      // the locations survive.
      if (isSearchOutput(rawText)) {
        const truncated = truncateSearchOutput(rawText, SEARCH_KEEP_LINES);
        if (truncated === rawText) return;
        recordCompression(rawText, truncated, event.toolName, "truncate", ctx);
        return { content: [{ type: "text", text: truncated }] };
      }

      const { provider, modelId } = chooseModel(settings, ctx);
      const modelSpec = `${provider}/${modelId}`;

      const key = contentHash(rawText);
      let summary = cache.get(key);
      if (!summary) {
        const outcome = await callModel(
          rawText,
          event.toolName,
          event.input,
          ctx,
          provider,
          modelId,
        );
        if (!outcome.ok) {
          reportFailure(outcome.reason);
          return;
        }
        summary = outcome.summary;
        cache.set(key, summary);
      }

      const compressed = buildCompressed(rawText, summary);
      recordCompression(rawText, compressed, event.toolName, modelSpec, ctx);

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
          if (isSearchOutput(rawText)) {
            const truncated = truncateSearchOutput(rawText, SEARCH_KEEP_LINES);
            if (truncated === rawText) {
              result.push(msg);
              continue;
            }
            anyChanged = true;
            recordCompression(rawText, truncated, tm.toolName, "truncate", ctx);
            result.push({
              ...msg,
              content: [{ type: "text" as const, text: truncated }],
            } as (typeof event.messages)[number]);
            continue;
          }
          const key = contentHash(rawText);
          let summary = cache.get(key);
          if (!summary) {
            // History carries no tool input, so the summariser gets the tool
            // name alone here. Live results are the ones that matter, and they
            // go through the hook above with their command intact.
            const outcome = await callModel(rawText, tm.toolName, {}, ctx, provider, modelId);
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
          recordCompression(rawText, compressed, tm.toolName, `${provider}/${modelId}`, ctx);
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
