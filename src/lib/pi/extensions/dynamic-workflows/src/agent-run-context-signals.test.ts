/**
 * §4.4 of docs/plans/subagent-context-pressure.md: "A unit test with a
 * session double that emits compaction_end asserts the fields reach
 * onAgentEnd." That seam is WorkflowAgent.run()'s onContextSignals callback
 * (agent.ts) feeding workflow.ts's onAgentEnd event — this file exercises the
 * real WorkflowAgent.run() against a session double, rather than a
 * WorkflowAgentRunner-level stub, so the fold in agent.ts's own subscribe()
 * listener (recordCompactionSignal/recordStopReason) is actually covered.
 *
 * pi-coding-agent's `createAgentSession` is mocked so no real session, model
 * runtime, or disk I/O is involved — the double controls exactly which
 * session events fire and what the terminal assistant message looks like.
 *
 * Also covers §6/§7: AGENT_CONTEXT_EXHAUSTED thrown by default (and not
 * recoverable), the `onContextExhausted: "partial"` opt-in resolving instead
 * of throwing, and the per-agent() `compaction` option reaching the fresh
 * SettingsManager's applyOverrides call agent.ts makes before createAgentSession.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type SessionEventListener = (event: Record<string, unknown>) => void;

/** One subagent session double: scripted messages, and a way to fire events. */
function makeSessionDouble(options: {
  messages: unknown[];
  events?: Record<string, unknown>[];
}) {
  const listeners: SessionEventListener[] = [];
  const session = {
    messages: options.messages,
    subscribe: vi.fn((listener: SessionEventListener) => {
      listeners.push(listener);
      return () => {
        const i = listeners.indexOf(listener);
        if (i !== -1) listeners.splice(i, 1);
      };
    }),
    prompt: vi.fn(async () => {
      for (const event of options.events ?? []) {
        for (const listener of listeners) listener(event);
      }
    }),
    abort: vi.fn(),
    dispose: vi.fn(),
    getSessionStats: vi.fn(() => ({
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
    })),
    setActiveToolsByName: vi.fn(),
  };
  return session;
}

const applyOverrides = vi.fn();
const settingsManagerCreate = vi.fn(() => ({
  applyOverrides,
  getCompactionEnabled: () => true,
}));

let nextSession: ReturnType<typeof makeSessionDouble> | undefined;
const createAgentSession = vi.fn(
  async (_options: { settingsManager?: { applyOverrides: typeof applyOverrides; getCompactionEnabled(): boolean } }) => ({
    session: nextSession,
  }),
);

// Hermetic against whatever the host actually has at ~/.pi/workflows/model-tiers.json
// (loadModelTierConfig reads real disk) — every test here leaves model/tier unset,
// so the untagged-agent branch is what would otherwise silently pick up the host's
// tiers config and route through a resolved model spec this double never expects.
vi.mock("./model-tier-config.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./model-tier-config.ts")>()),
  loadModelTierConfig: () => null,
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession,
  createCodingTools: () => [],
  DefaultResourceLoader: class {
    reload() {
      return Promise.resolve();
    }
  },
  getAgentDir: () => "/tmp/semla-agent-context-signals-test-agent-dir",
  ModelRegistry: class {
    // A private-in-real-life `runtime` field — runtimeOf() (agent.ts) reaches
    // for it via a cast, and warns once per process when it's missing. Present
    // here purely to keep that one-time console.warn out of this file's output.
    runtime = {};
    getAll() {
      return [];
    }
    getAvailable() {
      return [];
    }
    hasConfiguredAuth() {
      return false;
    }
  },
  ModelRuntime: class FakeModelRuntime {
    getAvailable() {
      return Promise.resolve([]);
    }
    static create() {
      return Promise.resolve(new FakeModelRuntime());
    }
  },
  SessionManager: {
    inMemory: () => ({}),
    create: () => ({}),
  },
  SettingsManager: {
    create: settingsManagerCreate,
    inMemory: () => ({ applyOverrides, getCompactionEnabled: () => true }),
  },
  defineTool: (tool: unknown) => tool,
  parseFrontmatter: () => ({ data: {}, content: "" }),
}));

const { WorkflowAgent } = await import("./agent.ts");
const { WorkflowErrorCode, isWorkflowError } = await import("./errors.ts");

const assistantMessage = (text: string, extra: Record<string, unknown> = {}) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  stopReason: "stop",
  ...extra,
});

beforeEach(() => {
  applyOverrides.mockClear();
  settingsManagerCreate.mockClear();
  createAgentSession.mockClear();
  nextSession = undefined;
});

describe("WorkflowAgent.run: context-pressure signals reach onContextSignals", () => {
  it("folds a compaction_end event's reason/compactions into the signals passed to onContextSignals", async () => {
    nextSession = makeSessionDouble({
      messages: [assistantMessage("done, after compacting")],
      events: [
        { type: "compaction_start", reason: "overflow" },
        {
          type: "compaction_end",
          reason: "overflow",
          willRetry: true,
          result: { tokensBefore: 150000, estimatedTokensAfter: 40000 },
        },
      ],
    });

    const runner = new WorkflowAgent({ cwd: "/tmp/semla-agent-context-signals-test" });
    let captured: import("./agent-context-signals.ts").AgentContextSignals | undefined;

    const result = await runner.run("do the thing", {
      label: "researcher",
      onContextSignals: (signals) => {
        captured = signals;
      },
    });

    expect(result).toBe("done, after compacting");
    expect(captured).toBeDefined();
    expect(captured?.compactions).toBe(1);
    expect(captured?.compactionReasons).toEqual(["overflow"]);
    expect(captured?.stopReason).toBe("stop");
    expect(captured?.events).toEqual([
      {
        reason: "overflow",
        willRetry: true,
        tokensBefore: 150000,
        estimatedTokensAfter: 40000,
      },
    ]);
  });

  it("reports zero compactions when the session never compacted", async () => {
    nextSession = makeSessionDouble({ messages: [assistantMessage("plain answer")] });

    const runner = new WorkflowAgent({ cwd: "/tmp/semla-agent-context-signals-test" });
    let captured: import("./agent-context-signals.ts").AgentContextSignals | undefined;

    await runner.run("do the thing", {
      label: "researcher",
      onContextSignals: (signals) => {
        captured = signals;
      },
    });

    expect(captured?.compactions).toBe(0);
    expect(captured?.compactionReasons).toEqual([]);
  });
});

describe("WorkflowAgent.run: AGENT_CONTEXT_EXHAUSTED (§6)", () => {
  it("throws a non-recoverable AGENT_CONTEXT_EXHAUSTED by default when stopReason is length", async () => {
    nextSession = makeSessionDouble({
      messages: [assistantMessage("cut off mid-", { stopReason: "length" })],
    });

    const runner = new WorkflowAgent({ cwd: "/tmp/semla-agent-context-signals-test" });

    await expect(
      runner.run("do the thing", { label: "researcher" }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(isWorkflowError(error)).toBe(true);
      if (!isWorkflowError(error)) return false;
      expect(error.code).toBe(WorkflowErrorCode.AGENT_CONTEXT_EXHAUSTED);
      expect(error.recoverable).toBe(false);
      expect(error.agentLabel).toBe("researcher");
      return true;
    });
  });

  it("throws when overflow recovery itself failed, even without a length stopReason", async () => {
    nextSession = makeSessionDouble({
      messages: [assistantMessage("", { stopReason: "error", content: [] })],
      events: [
        { type: "compaction_start", reason: "overflow" },
        {
          type: "compaction_end",
          reason: "overflow",
          willRetry: false,
          errorMessage:
            "Context overflow recovery failed after one compact-and-retry attempt.",
        },
      ],
    });

    const runner = new WorkflowAgent({ cwd: "/tmp/semla-agent-context-signals-test" });

    await expect(
      runner.run("do the thing", { label: "researcher" }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(isWorkflowError(error)).toBe(true);
      if (!isWorkflowError(error)) return false;
      expect(error.code).toBe(WorkflowErrorCode.AGENT_CONTEXT_EXHAUSTED);
      expect(error.recoverable).toBe(false);
      return true;
    });
  });

  it("does NOT throw when the subagent finished normally, even after an ordinary compaction", async () => {
    nextSession = makeSessionDouble({
      messages: [assistantMessage("finished normally")],
      events: [
        { type: "compaction_start", reason: "threshold" },
        { type: "compaction_end", reason: "threshold", willRetry: false },
      ],
    });

    const runner = new WorkflowAgent({ cwd: "/tmp/semla-agent-context-signals-test" });

    await expect(
      runner.run("do the thing", { label: "researcher" }),
    ).resolves.toBe("finished normally");
  });

  it("resolves with an explicit PartialAgentResult instead of throwing when onContextExhausted is 'partial'", async () => {
    nextSession = makeSessionDouble({
      messages: [assistantMessage("here is what I found before running out", {
        stopReason: "length",
      })],
    });

    const runner = new WorkflowAgent({ cwd: "/tmp/semla-agent-context-signals-test" });

    const result = await runner.run("do the thing", {
      label: "researcher",
      onContextExhausted: "partial",
    });

    // The type is required to be shaped, never a bare string a caller could
    // mistake for a complete result — assert both the value AND its shape.
    expect(result).toEqual({
      complete: false,
      reason: "context_exhausted",
      text: "here is what I found before running out",
    });
    if (typeof result === "string") {
      throw new Error("partial result must never be a bare string");
    }
    expect(result.complete).toBe(false);
  });
});

describe("WorkflowAgent.run: per-agent() compaction setting (§7)", () => {
  it("applies compaction:false as an in-memory settings override before session creation", async () => {
    nextSession = makeSessionDouble({ messages: [assistantMessage("ok")] });

    const runner = new WorkflowAgent({ cwd: "/tmp/semla-agent-context-signals-test" });
    await runner.run("do the thing", { label: "builder", compaction: false });

    expect(applyOverrides).toHaveBeenCalledWith({ compaction: { enabled: false } });
    expect(createAgentSession).toHaveBeenCalledTimes(1);
    // applyOverrides must run on the SAME SettingsManager instance handed to
    // createAgentSession, not a throwaway — otherwise the override would be
    // silently lost between the two calls.
    const passedSettingsManager = createAgentSession.mock.calls[0]?.[0]?.settingsManager;
    expect(passedSettingsManager).toBeDefined();
    expect(passedSettingsManager?.applyOverrides).toBe(applyOverrides);
  });

  it("applies compaction:true as an override too, not only the false case", async () => {
    nextSession = makeSessionDouble({ messages: [assistantMessage("ok")] });

    const runner = new WorkflowAgent({ cwd: "/tmp/semla-agent-context-signals-test" });
    await runner.run("do the thing", { label: "builder", compaction: true });

    expect(applyOverrides).toHaveBeenCalledWith({ compaction: { enabled: true } });
  });

  it("leaves the default unchanged: applyOverrides is never called when compaction is omitted", async () => {
    nextSession = makeSessionDouble({ messages: [assistantMessage("ok")] });

    const runner = new WorkflowAgent({ cwd: "/tmp/semla-agent-context-signals-test" });
    await runner.run("do the thing", { label: "builder" });

    expect(applyOverrides).not.toHaveBeenCalled();
    // The unmodified SettingsManager still reaches createAgentSession — the
    // default compaction setting is whatever it resolves from disk (§2.1),
    // untouched by this run.
    expect(createAgentSession).toHaveBeenCalledTimes(1);
    const passedSettingsManager = createAgentSession.mock.calls[0]?.[0]?.settingsManager;
    expect(passedSettingsManager?.getCompactionEnabled()).toBe(true);
  });
});
