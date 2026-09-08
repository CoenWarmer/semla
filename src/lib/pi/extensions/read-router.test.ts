/**
 * Tests for read-router.ts — the extension that replaces large tool results
 * with a cheap-model summary before they enter the frontier model's context.
 *
 * The interesting property here is not that compression happens. It is that
 * compression *does not* happen in the cases where a summary would be wrong:
 * an `edit` result whose exact text the model needs, an error the model has to
 * read verbatim, a summariser that failed or hung. Every one of those is a
 * silent failure mode — the model receives *something* either way, and a
 * summary in place of an error message reads as the tool having succeeded.
 * So most of what follows asserts a pass-through.
 *
 * Both hooks are exercised through a fake `ExtensionAPI`, matching how the
 * extension is wired at runtime, rather than by importing its private
 * predicates. `shouldCompress` is not exported and should not be: the
 * threshold policy is only meaningful in terms of what the hook returns.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ContextEvent,
  ExtensionContext,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";

const loadWorkflowSettings = vi.fn();
const getSpanSink = vi.fn();

vi.mock("./dynamic-workflows/src/workflow-settings", () => ({
  loadWorkflowSettings: (...args: unknown[]) =>
    loadWorkflowSettings(...args) as unknown,
}));

vi.mock("@/lib/pi/telemetry/sink-registry", () => ({
  getSpanSink: (...args: unknown[]) => getSpanSink(...args) as unknown,
}));

const readRouterExtension = (await import("./read-router")).default;

// ── Fakes ─────────────────────────────────────────────────────────────────────

type Handler = (event: unknown, ctx: unknown) => unknown;

/** A pi whose registered handlers can be fired directly. */
function makePi() {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on: vi.fn((event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }),
    registerTool: vi.fn(),
  } as unknown as Parameters<typeof readRouterExtension>[0];

  return {
    pi,
    fire: async (event: string, payload: unknown, ctx: unknown) => {
      const list = handlers.get(event) ?? [];
      let last: unknown;
      for (const handler of list) last = await handler(payload, ctx);
      return last;
    },
  };
}

/**
 * The slice of ExtensionContext the extension touches. `complete` is the one
 * that matters: it stands in for the summariser, and its call count is how the
 * cache is observed.
 */
function makeCtx(
  complete: (...args: unknown[]) => unknown = () => ({
    content: [{ text: "SUMMARY", type: "text" }],
    stopReason: "stop",
  }),
  {
    catalogue = [],
    modelFound = true,
    sessionProvider,
  }: {
    catalogue?: Array<{ id: string; provider: string; reasoning?: boolean }>;
    modelFound?: boolean;
    sessionProvider?: string;
  } = {},
) {
  const completeSpy = vi.fn(complete);
  return {
    completeSpy,
    ctx: {
      cwd: "/repo",
      // Undefined unless a test asks for one, which is the no-session-model
      // case and must keep using the hardcoded default.
      model: sessionProvider ? { id: "frontier", provider: sessionProvider } : undefined,
      modelRegistry: {
        complete: completeSpy,
        find: vi.fn(() => (modelFound ? { id: "m" } : undefined)),
        getAll: vi.fn(() => catalogue),
      },
      sessionManager: { getSessionId: () => "session-1" },
    } as unknown as ExtensionContext,
  };
}

function toolResult(
  toolName: string,
  text: string,
  isError = false,
): ToolResultEvent {
  return {
    content: [{ text, type: "text" }],
    input: {},
    isError,
    toolCallId: "call-1",
    toolName,
  } as unknown as ToolResultEvent;
}

/** Text of exactly `n` lines, wide enough to also clear a char threshold. */
function lines(n: number): string {
  return Array.from({ length: n }, (_, i) => `line ${i} ${"x".repeat(60)}`).join(
    "\n",
  );
}

function resultText(value: unknown): string | undefined {
  const content = (value as { content?: Array<{ text?: string }> } | undefined)
    ?.content;
  return content?.[0]?.text;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  loadWorkflowSettings.mockReturnValue({});
  getSpanSink.mockReturnValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  loadWorkflowSettings.mockReset();
  getSpanSink.mockReset();
});

// ── Registration ──────────────────────────────────────────────────────────────

describe("readRouterExtension", () => {
  it("registers the three hooks it needs and no others", () => {
    const { pi } = makePi();
    readRouterExtension(pi);

    const events = (pi.on as unknown as { mock: { calls: [string][] } }).mock
      .calls.map(([event]) => event);
    expect(new Set(events)).toEqual(
      new Set(["tool_result", "context", "session_shutdown"]),
    );
  });
});

// ── What must never be compressed ────────────────────────────────────────────

/**
 * Each of these would be a correctness bug rather than a missed optimisation,
 * and each fails silently: the model still receives content, just the wrong
 * content. The `edit`/`write` cases are the sharpest — a summarised diff looks
 * like a successful edit of something else.
 */
describe("tool_result pass-through", () => {
  it.each([
    ["edit", "an exact-content tool"],
    ["write", "an exact-content tool"],
  ])("never compresses %s (%s)", async (toolName) => {
    const { pi, fire } = makePi();
    readRouterExtension(pi);
    const { ctx, completeSpy } = makeCtx();

    const result = await fire("tool_result", toolResult(toolName, lines(5000)), ctx);

    expect(result).toBeUndefined();
    expect(completeSpy).not.toHaveBeenCalled();
  });

  it("never compresses an error result", async () => {
    const { pi, fire } = makePi();
    readRouterExtension(pi);
    const { ctx, completeSpy } = makeCtx();

    const result = await fire(
      "tool_result",
      toolResult("bash", lines(5000), true),
      ctx,
    );

    expect(result).toBeUndefined();
    expect(completeSpy).not.toHaveBeenCalled();
  });

  it("does not re-compress its own output", async () => {
    const { pi, fire } = makePi();
    readRouterExtension(pi);
    const { ctx, completeSpy } = makeCtx();

    const already = `[Compressed: 9999 chars → via read-router]\n\n${lines(1000)}`;
    const result = await fire("tool_result", toolResult("read", already), ctx);

    expect(result).toBeUndefined();
    expect(completeSpy).not.toHaveBeenCalled();
  });

  it("ignores a tool it has no threshold for", async () => {
    const { pi, fire } = makePi();
    readRouterExtension(pi);
    const { ctx, completeSpy } = makeCtx();

    const result = await fire(
      "tool_result",
      toolResult("some_mcp_tool", lines(5000)),
      ctx,
    );

    expect(result).toBeUndefined();
    expect(completeSpy).not.toHaveBeenCalled();
  });

  it("leaves the result alone when the summariser throws", async () => {
    const { pi, fire } = makePi();
    readRouterExtension(pi);
    const { ctx } = makeCtx(() => {
      throw new Error("provider down");
    });

    const result = await fire("tool_result", toolResult("read", lines(400)), ctx);

    expect(result).toBeUndefined();
  });

  it("leaves the result alone when the model id resolves to nothing", async () => {
    const { pi, fire } = makePi();
    readRouterExtension(pi);
    const { ctx } = makeCtx(undefined, { modelFound: false });

    const result = await fire("tool_result", toolResult("read", lines(400)), ctx);

    expect(result).toBeUndefined();
  });

  it("leaves the result alone when the summary comes back empty", async () => {
    const { pi, fire } = makePi();
    readRouterExtension(pi);
    const { ctx } = makeCtx(() => ({
      content: [{ text: "", type: "text" }],
      stopReason: "stop",
    }));

    const result = await fire("tool_result", toolResult("read", lines(400)), ctx);

    expect(result).toBeUndefined();
  });

  /**
   * The regression this whole file exists for.
   *
   * complete() does not throw for an unconfigured provider — it resolves with
   * stopReason "error" and an empty content array. Measured against pi 0.84.2
   * on a host with no `anthropic` key, where it made the extension compress 0
   * of 7 eligible results without a single log line. A mock that only ever
   * throws cannot reach this path, which is why the first version of these
   * tests passed against broken code.
   */
  it("treats stopReason error as a failure, not as an empty summary", async () => {
    const { pi, fire } = makePi();
    readRouterExtension(pi);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ctx } = makeCtx(() => ({
      content: [],
      errorMessage: "Provider is not configured: anthropic",
      stopReason: "error",
      usage: { input: 0, output: 0 },
    }));

    const result = await fire("tool_result", toolResult("read", lines(400)), ctx);

    expect(result).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("Provider is not configured: anthropic");
  });

  it("does not cache a failure as if it were a summary", async () => {
    // A cached empty summary would poison every later result with the same
    // bytes, and would also hide the failure from the warning path.
    const { pi, fire } = makePi();
    readRouterExtension(pi);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ctx, completeSpy } = makeCtx(() => ({
      content: [],
      errorMessage: "nope",
      stopReason: "error",
    }));

    const text = lines(400);
    await fire("tool_result", toolResult("read", text), ctx);
    await fire("tool_result", toolResult("read", text), ctx);

    expect(completeSpy).toHaveBeenCalledTimes(2);
  });

  it("warns once per session rather than once per tool call", async () => {
    const { pi, fire } = makePi();
    readRouterExtension(pi);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ctx } = makeCtx(() => ({
      content: [],
      errorMessage: "Provider is not configured: anthropic",
      stopReason: "error",
    }));

    for (let i = 0; i < 4; i++) {
      await fire("tool_result", toolResult("read", lines(400 + i)), ctx);
    }

    expect(warn).toHaveBeenCalledTimes(1);
  });
});

// ── Thresholds ────────────────────────────────────────────────────────────────

describe("tool_result thresholds", () => {
  it("compresses a read over the default 300-line threshold", async () => {
    const { pi, fire } = makePi();
    readRouterExtension(pi);
    const { ctx } = makeCtx();

    const result = await fire("tool_result", toolResult("read", lines(301)), ctx);

    expect(resultText(result)).toContain("SUMMARY");
    expect(resultText(result)).toMatch(/^\[Compressed: \d+ chars → via read-router\]/);
  });

  it("leaves a read at the default threshold uncompressed", async () => {
    const { pi, fire } = makePi();
    readRouterExtension(pi);
    const { ctx, completeSpy } = makeCtx();

    // 300 lines is not "> 300" — the boundary is exclusive, and a test that
    // only checked 1 vs 5000 would not notice it moving.
    const result = await fire("tool_result", toolResult("read", lines(300)), ctx);

    expect(result).toBeUndefined();
    expect(completeSpy).not.toHaveBeenCalled();
  });

  it("compresses bash on characters, not lines", async () => {
    const { pi, fire } = makePi();
    readRouterExtension(pi);
    const { ctx } = makeCtx();

    // One line, over the 3000-char default: a line-based rule would miss this.
    const result = await fire(
      "tool_result",
      toolResult("bash", "y".repeat(3001)),
      ctx,
    );

    expect(resultText(result)).toContain("SUMMARY");
  });

  it("leaves short bash output alone", async () => {
    const { pi, fire } = makePi();
    readRouterExtension(pi);
    const { ctx, completeSpy } = makeCtx();

    const result = await fire("tool_result", toolResult("bash", "ok"), ctx);

    expect(result).toBeUndefined();
    expect(completeSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["grep", 41, 40],
    ["find", 41, 40],
    ["ls", 81, 80],
  ])(
    "compresses %s above its own line threshold but not at it",
    async (toolName, over, at) => {
      const { pi, fire } = makePi();
      readRouterExtension(pi);
      const { ctx } = makeCtx();

      expect(
        resultText(await fire("tool_result", toolResult(toolName, lines(over)), ctx)),
      ).toContain("SUMMARY");

      expect(
        await fire("tool_result", toolResult(toolName, lines(at)), ctx),
      ).toBeUndefined();
    },
  );
});

// ── Search output ─────────────────────────────────────────────────────────

/** `n` ripgrep-style matches spread over two files. */
function matchLines(n: number): string {
  return Array.from(
    { length: n },
    (_, i) => `src/lib/file${i % 2}.ts:${i + 1}:export const thing${i} = 1;`,
  ).join("\n");
}

/**
 * Search output is truncated, never summarised.
 *
 * Measured, not preferred: told explicitly to preserve every path and line
 * number, to treat locations as the payload and to drop matched source before
 * dropping a location, the summariser still returned 0 of 14 filenames and no
 * line numbers for a real `rg -n` result. It flattens matches into a symbol
 * list, and a `path:line` the agent cannot jump to is worse than no compression
 * at all.
 */
describe("search output", () => {
  it("truncates without calling the model at all", async () => {
    const { pi, fire } = makePi();
    readRouterExtension(pi);
    const { ctx, completeSpy } = makeCtx();

    const result = await fire("tool_result", toolResult("bash", matchLines(200)), ctx);

    expect(completeSpy).not.toHaveBeenCalled();
    expect(resultText(result)).toMatch(/^\[Compressed: \d+ chars → via read-router\]/);
  });

  it("keeps paths and line numbers verbatim", async () => {
    const { pi, fire } = makePi();
    readRouterExtension(pi);
    const { ctx } = makeCtx();

    const text = resultText(
      await fire("tool_result", toolResult("bash", matchLines(200)), ctx),
    );

    expect(text).toContain("src/lib/file0.ts:1:");
    expect(text).toContain("src/lib/file1.ts:2:");
  });

  it("says how many matches it dropped", async () => {
    // Silently dropping matches would let an agent conclude a symbol has no
    // further references.
    const { pi, fire } = makePi();
    readRouterExtension(pi);
    const { ctx } = makeCtx();

    const text = resultText(
      await fire("tool_result", toolResult("bash", matchLines(200)), ctx),
    );

    expect(text).toMatch(/… \d+ more match\(es\) not shown/);
  });

  it("detects search output from the text, not the tool name", async () => {
    // `rg -n …` arrives as a bash result, which is how the original failure
    // reached the summariser — a tool-name check would miss it entirely.
    const { pi, fire } = makePi();
    readRouterExtension(pi);
    const { ctx, completeSpy } = makeCtx();

    await fire("tool_result", toolResult("bash", matchLines(200)), ctx);

    expect(completeSpy).not.toHaveBeenCalled();
  });

  it("leaves a short match list alone", async () => {
    const { pi, fire } = makePi();
    readRouterExtension(pi);
    const { ctx, completeSpy } = makeCtx();

    // Over bash's char threshold so it reaches the search path, but under the
    // keep count — nothing to drop, so it must pass through unchanged.
    const padded = `${matchLines(20)}\n${"# padding".repeat(400)}`;
    const result = await fire("tool_result", toolResult("bash", padded), ctx);

    expect(result).toBeUndefined();
    expect(completeSpy).not.toHaveBeenCalled();
  });

  it("summarises prose that merely mentions a path", async () => {
    // The majority test must not misfire on ordinary output containing one
    // path:line reference.
    const { pi, fire } = makePi();
    readRouterExtension(pi);
    const { ctx, completeSpy } = makeCtx();

    const prose = `Checked src/a.ts:12 and found nothing.\n${"Ordinary prose line.\n".repeat(300)}`;
    const result = await fire("tool_result", toolResult("bash", prose), ctx);

    expect(completeSpy).toHaveBeenCalledTimes(1);
    expect(resultText(result)).toContain("SUMMARY");
  });

  it("truncates search output in history too", async () => {
    const { pi, fire } = makePi();
    readRouterExtension(pi);
    const { ctx, completeSpy } = makeCtx();

    const result = (await fire(
      "context",
      contextEvent([toolResultMessage("bash", matchLines(200))]),
      ctx,
    )) as { messages: Array<{ content: Array<{ text: string }> }> };

    expect(completeSpy).not.toHaveBeenCalled();
    expect(result.messages[0].content[0].text).toContain("src/lib/file0.ts:1:");
  });
});

// ── Settings ──────────────────────────────────────────────────────────────────

describe("settings", () => {
  it("is off when readRouterEnabled is false", async () => {
    loadWorkflowSettings.mockReturnValue({ readRouterEnabled: false });
    const { pi, fire } = makePi();
    readRouterExtension(pi);
    const { ctx, completeSpy } = makeCtx();

    const result = await fire("tool_result", toolResult("read", lines(5000)), ctx);

    expect(result).toBeUndefined();
    expect(completeSpy).not.toHaveBeenCalled();
  });

  it("is on when the setting is absent entirely", async () => {
    loadWorkflowSettings.mockReturnValue({});
    const { pi, fire } = makePi();
    readRouterExtension(pi);
    const { ctx } = makeCtx();

    expect(
      resultText(await fire("tool_result", toolResult("read", lines(400)), ctx)),
    ).toContain("SUMMARY");
  });

  it("honours a configured line threshold", async () => {
    loadWorkflowSettings.mockReturnValue({ readRouterThresholdLines: 10 });
    const { pi, fire } = makePi();
    readRouterExtension(pi);
    const { ctx } = makeCtx();

    expect(
      resultText(await fire("tool_result", toolResult("read", lines(11)), ctx)),
    ).toContain("SUMMARY");
  });

  it("honours a configured char threshold for bash", async () => {
    loadWorkflowSettings.mockReturnValue({ readRouterThresholdChars: 10 });
    const { pi, fire } = makePi();
    readRouterExtension(pi);
    const { ctx } = makeCtx();

    expect(
      resultText(await fire("tool_result", toolResult("bash", "z".repeat(11)), ctx)),
    ).toContain("SUMMARY");
  });

  it("tells the summariser what the agent actually ran", async () => {
    // The prompt used to say "extract lines relevant to the apparent task"
    // while showing the model nothing but output, so it inferred a task. The
    // command is in event.input and is far more informative than the bytes it
    // produced.
    const { pi, fire } = makePi();
    readRouterExtension(pi);
    const { ctx, completeSpy } = makeCtx();

    const event = toolResult("bash", `${"prose line\n".repeat(400)}`);
    (event as unknown as { input: Record<string, unknown> }).input = {
      command: "rg -n 'export' src/lib/pi | head -60",
    };
    await fire("tool_result", event, ctx);

    const context = completeSpy.mock.calls[0][1] as {
      messages: Array<{ content: string }>;
    };
    expect(context.messages[0].content).toContain("rg -n 'export' src/lib/pi");
  });

  it("names the file for a read, and survives an empty input", async () => {
    const { pi, fire } = makePi();
    readRouterExtension(pi);
    const { ctx, completeSpy } = makeCtx();

    const event = toolResult("read", lines(400));
    (event as unknown as { input: Record<string, unknown> }).input = {
      path: "src/lib/pi/extension-manifest.ts",
    };
    await fire("tool_result", event, ctx);

    const first = completeSpy.mock.calls[0][1] as { messages: Array<{ content: string }> };
    expect(first.messages[0].content).toContain("src/lib/pi/extension-manifest.ts");

    // History carries no input; the tool name alone must still produce a
    // well-formed prompt rather than "undefined".
    await fire("context", contextEvent([toolResultMessage("read", lines(401))]), ctx);
    const second = completeSpy.mock.calls[1][1] as { messages: Array<{ content: string }> };
    expect(second.messages[0].content).not.toContain("undefined");
    expect(second.messages[0].content).toContain("`read`");
  });

  it("splits provider/modelId on the first slash only", async () => {
    // An OpenRouter-style id carries a slash of its own, and splitting on the
    // last one would send the request to a provider named "anthropic/claude".
    loadWorkflowSettings.mockReturnValue({
      readRouterModel: "openrouter/anthropic/claude-haiku",
    });
    const { pi, fire } = makePi();
    readRouterExtension(pi);
    const { ctx } = makeCtx();
    const find = (ctx.modelRegistry as unknown as { find: ReturnType<typeof vi.fn> })
      .find;

    await fire("tool_result", toolResult("read", lines(400)), ctx);

    expect(find).toHaveBeenCalledWith("openrouter", "anthropic/claude-haiku");
  });

  it("defaults to a model id the installed catalogue actually has", async () => {
    const { pi, fire } = makePi();
    readRouterExtension(pi);
    const { ctx } = makeCtx();
    const find = (ctx.modelRegistry as unknown as { find: ReturnType<typeof vi.fn> })
      .find;

    await fire("tool_result", toolResult("read", lines(400)), ctx);

    // Pinned deliberately: `find` returning undefined for a typo'd id makes the
    // extension a silent no-op, which is indistinguishable from it being off.
    expect(find).toHaveBeenCalledWith(
      "anthropic",
      "claude-haiku-4-5-20251001",
    );
  });
});

// ── Provider selection ────────────────────────────────────────────────────────

/**
 * The default model names the `anthropic` provider, and a host driving its
 * session through a gateway need not have an `anthropic` key at all — that is
 * exactly the configuration the extension was found broken on. The session's
 * own provider is reachable by definition, so it is preferred.
 */
describe("provider selection", () => {
  const openrouter = [
    { id: "anthropic/claude-haiku-4.5", provider: "openrouter", reasoning: false },
    { id: "anthropic/claude-haiku-4.5:batch", provider: "openrouter", reasoning: false },
    { id: "anthropic/claude-opus-5", provider: "openrouter", reasoning: false },
    { id: "anthropic/claude-3-haiku", provider: "openrouter", reasoning: false },
    { id: "claude-haiku-4-5-20251001", provider: "anthropic", reasoning: false },
  ];

  it("borrows the session's provider when it differs from the default", async () => {
    const { pi, fire } = makePi();
    readRouterExtension(pi);
    const { ctx } = makeCtx(undefined, {
      catalogue: openrouter,
      sessionProvider: "openrouter",
    });
    const find = (ctx.modelRegistry as unknown as { find: ReturnType<typeof vi.fn> })
      .find;

    await fire("tool_result", toolResult("read", lines(400)), ctx);

    const [provider, modelId] = find.mock.calls[0] as [string, string];
    expect(provider).toBe("openrouter");
    // A cheap model, addressed the way that provider spells it.
    expect(modelId).toMatch(/haiku/);
    // Never a :batch id — those do not answer synchronously.
    expect(modelId).not.toContain("batch");
  });

  it("rejects a batch id even when it would otherwise be the best match", async () => {
    // The shortest-id tiebreak alone does not exclude these: a gateway can
    // spell a batch variant more tersely than its interactive sibling, and a
    // batch endpoint does not answer synchronously, so a summary would never
    // arrive and every compression would silently fail open.
    const { pi, fire } = makePi();
    readRouterExtension(pi);
    const { ctx } = makeCtx(undefined, {
      catalogue: [
        { id: "haiku:batch", provider: "acme" },
        { id: "claude-haiku-4.5", provider: "acme" },
      ],
      sessionProvider: "acme",
    });
    const find = (ctx.modelRegistry as unknown as { find: ReturnType<typeof vi.fn> })
      .find;

    await fire("tool_result", toolResult("read", lines(400)), ctx);

    expect(find).toHaveBeenCalledWith("acme", "claude-haiku-4.5");
  });

  it("skips reasoning models, which reject the request outright", async () => {
    // Found live, not reasoned out: pi sends `reasoning.effort: "none"` for a
    // plain completion and OpenAI's o-series answers 400 unsupported_value, so
    // picking one fails on every single result.
    const { pi, fire } = makePi();
    readRouterExtension(pi);
    const { ctx } = makeCtx(undefined, {
      catalogue: [
        { id: "openai/o3-mini", provider: "acme", reasoning: true },
        { id: "openai/gpt-4o-mini", provider: "acme", reasoning: false },
      ],
      sessionProvider: "acme",
    });
    const find = (ctx.modelRegistry as unknown as { find: ReturnType<typeof vi.fn> })
      .find;

    await fire("tool_result", toolResult("read", lines(400)), ctx);

    expect(find).toHaveBeenCalledWith("acme", "openai/gpt-4o-mini");
  });

  it("does not mistake a vendor named 'minimax' for a mini model", async () => {
    // Also found live. An unanchored /mini/ matched minimax/minimax-m1 — a
    // different vendor's frontier model, and the shortest id in the list.
    const { pi, fire } = makePi();
    readRouterExtension(pi);
    const { ctx } = makeCtx(undefined, {
      catalogue: [
        { id: "minimax/minimax-m1", provider: "acme", reasoning: false },
        { id: "anthropic/claude-haiku-4.5", provider: "acme", reasoning: false },
      ],
      sessionProvider: "acme",
    });
    const find = (ctx.modelRegistry as unknown as { find: ReturnType<typeof vi.fn> })
      .find;

    await fire("tool_result", toolResult("read", lines(400)), ctx);

    expect(find).toHaveBeenCalledWith("acme", "anthropic/claude-haiku-4.5");
  });

  it("never borrows the session's own frontier model id", async () => {
    // Summarising cheap output with the frontier model would cost more than the
    // context it saves, which would make the extension worse than absent.
    const { pi, fire } = makePi();
    readRouterExtension(pi);
    const { ctx } = makeCtx(undefined, {
      catalogue: openrouter,
      sessionProvider: "openrouter",
    });
    const find = (ctx.modelRegistry as unknown as { find: ReturnType<typeof vi.fn> })
      .find;

    await fire("tool_result", toolResult("read", lines(400)), ctx);

    expect((find.mock.calls[0] as [string, string])[1]).not.toBe("frontier");
    expect((find.mock.calls[0] as [string, string])[1]).not.toContain("opus");
  });

  it("keeps the default when the session is already on that provider", async () => {
    const { pi, fire } = makePi();
    readRouterExtension(pi);
    const { ctx } = makeCtx(undefined, {
      catalogue: openrouter,
      sessionProvider: "anthropic",
    });
    const find = (ctx.modelRegistry as unknown as { find: ReturnType<typeof vi.fn> })
      .find;

    await fire("tool_result", toolResult("read", lines(400)), ctx);

    expect(find).toHaveBeenCalledWith("anthropic", "claude-haiku-4-5-20251001");
  });

  it("keeps the default when the session provider has no cheap model", async () => {
    const { pi, fire } = makePi();
    readRouterExtension(pi);
    const { ctx } = makeCtx(undefined, {
      catalogue: [{ id: "some-big-model", provider: "acme" }],
      sessionProvider: "acme",
    });
    const find = (ctx.modelRegistry as unknown as { find: ReturnType<typeof vi.fn> })
      .find;

    await fire("tool_result", toolResult("read", lines(400)), ctx);

    expect(find).toHaveBeenCalledWith("anthropic", "claude-haiku-4-5-20251001");
  });

  it("obeys an explicit readRouterModel over the session provider", async () => {
    // A configured value is a decision. Substituting something else silently
    // would be worse than failing.
    loadWorkflowSettings.mockReturnValue({ readRouterModel: "anthropic/claude-haiku-4-5-20251001" });
    const { pi, fire } = makePi();
    readRouterExtension(pi);
    const { ctx } = makeCtx(undefined, {
      catalogue: openrouter,
      sessionProvider: "openrouter",
    });
    const find = (ctx.modelRegistry as unknown as { find: ReturnType<typeof vi.fn> })
      .find;

    await fire("tool_result", toolResult("read", lines(400)), ctx);

    expect(find).toHaveBeenCalledWith("anthropic", "claude-haiku-4-5-20251001");
  });
});

// ── Cache ─────────────────────────────────────────────────────────────────────

describe("content-hash cache", () => {
  it("summarises identical content once across calls", async () => {
    const { pi, fire } = makePi();
    readRouterExtension(pi);
    const { ctx, completeSpy } = makeCtx();

    const text = lines(400);
    const first = await fire("tool_result", toolResult("read", text), ctx);
    const second = await fire("tool_result", toolResult("read", text), ctx);

    expect(completeSpy).toHaveBeenCalledTimes(1);
    expect(resultText(second)).toBe(resultText(first));
  });

  it("summarises differing content separately", async () => {
    const { pi, fire } = makePi();
    readRouterExtension(pi);
    const { ctx, completeSpy } = makeCtx();

    await fire("tool_result", toolResult("read", lines(400)), ctx);
    await fire("tool_result", toolResult("read", lines(401)), ctx);

    expect(completeSpy).toHaveBeenCalledTimes(2);
  });
});

// ── Telemetry ─────────────────────────────────────────────────────────────────

describe("telemetry", () => {
  it("emits a read_router.compress span with the ratio", async () => {
    const span = { close: vi.fn(), setAttributes: vi.fn() };
    const sink = { openSpan: vi.fn(() => span) };
    getSpanSink.mockReturnValue(sink);

    const { pi, fire } = makePi();
    readRouterExtension(pi);
    const { ctx } = makeCtx();

    await fire("tool_result", toolResult("read", lines(400)), ctx);

    expect(sink.openSpan).toHaveBeenCalledWith({ name: "read_router.compress" });
    expect(span.setAttributes).toHaveBeenCalledWith(
      expect.objectContaining({ model: expect.any(String), tool: "read" }),
    );
    const attrs = span.setAttributes.mock.calls[0][0] as {
      compressedChars: number;
      originalChars: number;
      ratio: number;
    };
    expect(attrs.compressedChars).toBeLessThan(attrs.originalChars);
    expect(attrs.ratio).toBeLessThan(1);
    expect(span.close).toHaveBeenCalled();
  });

  it("still compresses when there is no span sink", async () => {
    getSpanSink.mockReturnValue(undefined);
    const { pi, fire } = makePi();
    readRouterExtension(pi);
    const { ctx } = makeCtx();

    expect(
      resultText(await fire("tool_result", toolResult("read", lines(400)), ctx)),
    ).toContain("SUMMARY");
  });

  it("reports a failed-but-never-compressed session at shutdown", async () => {
    // The signature of the original bug: thresholds fine, hooks fine, nothing
    // compressed, nothing said.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { pi, fire } = makePi();
    readRouterExtension(pi);
    const { ctx } = makeCtx(() => ({
      content: [],
      errorMessage: "Provider is not configured: anthropic",
      stopReason: "error",
    }));

    await fire("tool_result", toolResult("read", lines(400)), ctx);
    await fire("session_shutdown", {}, undefined);

    expect(info).not.toHaveBeenCalled();
    expect(
      warn.mock.calls.some(([m]) => String(m).includes("0 compressions")),
    ).toBe(true);
  });

  it("reports a reduction at shutdown, and says nothing when idle", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    const idle = makePi();
    readRouterExtension(idle.pi);
    await idle.fire("session_shutdown", {}, undefined);
    expect(info).not.toHaveBeenCalled();

    const busy = makePi();
    readRouterExtension(busy.pi);
    const { ctx } = makeCtx();
    await busy.fire("tool_result", toolResult("read", lines(400)), ctx);
    await busy.fire("session_shutdown", {}, undefined);

    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0][0]).toMatch(
      /\[read-router\] 1 compression\(s\): \d+ → \d+ chars \(\d+% reduction\)/,
    );
  });
});

// ── The context hook ──────────────────────────────────────────────────────────

function contextEvent(
  messages: Array<Record<string, unknown>>,
): ContextEvent {
  return { messages, type: "context" } as unknown as ContextEvent;
}

function toolResultMessage(toolName: string, text: string, isError = false) {
  return {
    content: [{ text, type: "text" }],
    isError,
    role: "toolResult",
    toolName,
  };
}

describe("context hook", () => {
  it("compresses history in place and leaves other roles untouched", async () => {
    const { pi, fire } = makePi();
    readRouterExtension(pi);
    const { ctx } = makeCtx();

    const user = { content: "hello", role: "user" };
    const result = (await fire(
      "context",
      contextEvent([user, toolResultMessage("read", lines(400))]),
      ctx,
    )) as { messages: Array<Record<string, unknown>> };

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toBe(user);
    const compressed = result.messages[1] as {
      content: Array<{ text: string }>;
      role: string;
      toolName: string;
    };
    expect(compressed.content[0].text).toContain("SUMMARY");
    // The rest of the message must survive: a toolResult that loses its
    // toolName or role is no longer answerable to its tool call.
    expect(compressed.role).toBe("toolResult");
    expect(compressed.toolName).toBe("read");
  });

  it("returns nothing when no message crosses a threshold", async () => {
    const { pi, fire } = makePi();
    readRouterExtension(pi);
    const { ctx, completeSpy } = makeCtx();

    const result = await fire(
      "context",
      contextEvent([
        { content: "hi", role: "user" },
        toolResultMessage("read", lines(5)),
      ]),
      ctx,
    );

    // Undefined rather than an identical array, so pi does not replace the
    // history with a copy of itself on every turn.
    expect(result).toBeUndefined();
    expect(completeSpy).not.toHaveBeenCalled();
  });

  it("applies the same exclusions as the tool_result hook", async () => {
    const { pi, fire } = makePi();
    readRouterExtension(pi);
    const { ctx, completeSpy } = makeCtx();

    const result = await fire(
      "context",
      contextEvent([
        toolResultMessage("edit", lines(500)),
        toolResultMessage("bash", lines(500), true),
      ]),
      ctx,
    );

    expect(result).toBeUndefined();
    expect(completeSpy).not.toHaveBeenCalled();
  });

  it("shares the cache with the tool_result hook", async () => {
    const { pi, fire } = makePi();
    readRouterExtension(pi);
    const { ctx, completeSpy } = makeCtx();

    const text = lines(400);
    await fire("tool_result", toolResult("read", text), ctx);
    await fire("context", contextEvent([toolResultMessage("read", text)]), ctx);

    expect(completeSpy).toHaveBeenCalledTimes(1);
  });

  it("gives up rather than delaying a turn when the summariser hangs", async () => {
    vi.useFakeTimers();
    const { pi, fire } = makePi();
    readRouterExtension(pi);
    const { ctx } = makeCtx(() => new Promise(() => {}));

    const pending = fire(
      "context",
      contextEvent([toolResultMessage("read", lines(400))]),
      ctx,
    );

    await vi.advanceTimersByTimeAsync(2000);

    // The whole point of the guard: a slow model must cost the turn nothing,
    // and the model sees the uncompressed history instead.
    expect(await pending).toBeUndefined();
  });
});
