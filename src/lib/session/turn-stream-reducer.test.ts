import { describe, expect, it } from "vitest";

import {
  applyStreamEvent,
  initialStreamState,
  resetForNewTurn,
  type TurnStreamState,
} from "@/lib/session/turn-stream-reducer";

describe("applyStreamEvent", () => {
  it("starts with no server-running override by default", () => {
    expect(initialStreamState().serverIsRunning).toBe(false);
    expect(initialStreamState({ serverIsRunning: true }).serverIsRunning).toBe(
      true,
    );
  });

  it("folds round-start and assistant-delta into liveRounds, in order", () => {
    let { state } = applyStreamEvent(initialStreamState(), {
      roundId: "live-round-1",
      type: "round-start",
    });
    ({ state } = applyStreamEvent(state, {
      delta: "Hel",
      roundId: "live-round-1",
      type: "assistant-delta",
    }));
    ({ state } = applyStreamEvent(state, {
      delta: "lo",
      roundId: "live-round-1",
      type: "assistant-delta",
    }));

    expect(state.liveRounds).toEqual([{ id: "live-round-1", text: "Hello" }]);
  });

  it("interleaves two rounds' deltas without bleeding into each other", () => {
    let state = initialStreamState();
    ({ state } = applyStreamEvent(state, {
      roundId: "live-round-1",
      type: "round-start",
    }));
    ({ state } = applyStreamEvent(state, {
      delta: "first",
      roundId: "live-round-1",
      type: "assistant-delta",
    }));
    ({ state } = applyStreamEvent(state, {
      roundId: "live-round-2",
      type: "round-start",
    }));
    ({ state } = applyStreamEvent(state, {
      delta: "second",
      roundId: "live-round-2",
      type: "assistant-delta",
    }));

    expect(state.liveRounds).toEqual([
      { id: "live-round-1", text: "first" },
      { id: "live-round-2", text: "second" },
    ]);
  });

  it("sets activeTool on tool-start and clears it on tool-end", () => {
    let state = initialStreamState();
    ({ state } = applyStreamEvent(state, {
      at: "2026-01-01T00:00:00.000Z",
      roundId: "live-round-1",
      toolCallId: "call-1",
      toolName: "read",
      type: "tool-start",
    }));
    expect(state.activeTool).toBe("read");

    ({ state } = applyStreamEvent(state, {
      at: "2026-01-01T00:00:01.000Z",
      isError: false,
      roundId: "live-round-1",
      toolCallId: "call-1",
      toolName: "read",
      type: "tool-end",
    }));
    expect(state.activeTool).toBeUndefined();
  });

  it("emits a bash console effect only for the bash tool, on both ends", () => {
    const { effects: startEffects } = applyStreamEvent(initialStreamState(), {
      at: "t0",
      params: { command: "ls" },
      roundId: "live-round-1",
      toolCallId: "call-1",
      toolName: "bash",
      type: "tool-start",
    });
    expect(startEffects).toContainEqual({
      at: "t0",
      command: "ls",
      toolCallId: "call-1",
      type: "console-bash-start",
    });

    const { effects: nonBashEffects } = applyStreamEvent(initialStreamState(), {
      at: "t0",
      roundId: "live-round-1",
      toolCallId: "call-2",
      toolName: "read",
      type: "tool-start",
    });
    expect(
      nonBashEffects.some((effect) => effect.type === "console-bash-start"),
    ).toBe(false);

    const { effects: endEffects } = applyStreamEvent(initialStreamState(), {
      at: "t1",
      isError: false,
      resultText: "ok",
      roundId: "live-round-1",
      toolCallId: "call-1",
      toolName: "bash",
      type: "tool-end",
    });
    expect(endEffects).toContainEqual({
      at: "t1",
      isError: false,
      output: "ok",
      toolCallId: "call-1",
      type: "console-bash-end",
    });
  });

  it("clears pendingQuestion when ask_user ends, and pendingFeatureSpec when capture_feature_spec ends", () => {
    let state: TurnStreamState = {
      ...initialStreamState(),
      pendingFeatureSpec: true,
      pendingQuestion: { id: "q1", questions: [] } as never,
    };

    ({ state } = applyStreamEvent(state, {
      at: "t1",
      isError: false,
      roundId: "live-round-1",
      toolCallId: "call-1",
      toolName: "ask_user",
      type: "tool-end",
    }));
    expect(state.pendingQuestion).toBeNull();
    expect(state.pendingFeatureSpec).toBe(true);

    ({ state } = applyStreamEvent(state, {
      at: "t2",
      isError: false,
      roundId: "live-round-1",
      toolCallId: "call-2",
      toolName: "capture_feature_spec",
      type: "tool-end",
    }));
    expect(state.pendingFeatureSpec).toBe(false);
  });

  it("latches wikiActive true on a wiki-activity tool and keeps it true after", () => {
    let state = initialStreamState();
    expect(state.wikiActive).toBe(false);

    ({ state } = applyStreamEvent(state, {
      at: "t0",
      roundId: "live-round-1",
      toolCallId: "call-1",
      toolName: "wiki_ingest",
      type: "tool-start",
    }));
    expect(state.wikiActive).toBe(true);

    ({ state } = applyStreamEvent(state, {
      at: "t1",
      roundId: "live-round-2",
      toolCallId: "call-2",
      toolName: "read",
      type: "tool-start",
    }));
    expect(state.wikiActive).toBe(true);
  });

  it("merges spans by id and emits a cache-spans effect", () => {
    const first = { spanId: "a", name: "one" } as never;
    const second = { spanId: "a", name: "one-updated" } as never;

    let state = initialStreamState();
    ({ state } = applyStreamEvent(state, { spans: [first], type: "spans" }));
    expect(state.spansById.get("a")).toEqual(first);

    const result = applyStreamEvent(state, { spans: [second], type: "spans" });
    expect(result.state.spansById.get("a")).toEqual(second);
    expect(result.effects).toEqual([{ spans: [second], type: "cache-spans" }]);
  });

  it("records workflow-started as a synthetic snapshot", () => {
    const { state } = applyStreamEvent(initialStreamState(), {
      runId: "run-1",
      startedAt: "2026-01-01T00:00:00.000Z",
      type: "workflow-started",
    });

    expect(state.workflowSnapshot).toMatchObject({
      name: "Background workflow",
      runId: "run-1",
    });
  });

  it("replaces the workflow snapshot wholesale on workflow-snapshot", () => {
    const snapshot = { agentCount: 1 } as never;
    const { state } = applyStreamEvent(initialStreamState(), {
      snapshot,
      type: "workflow-snapshot",
    });

    expect(state.workflowSnapshot).toBe(snapshot);
  });

  it("emits an invalidate-title effect and updates serverTitle on title-updated", () => {
    const { effects, state } = applyStreamEvent(initialStreamState(), {
      title: "New title",
      type: "title-updated",
    });

    expect(state.serverTitle).toBe("New title");
    expect(effects).toEqual([{ title: "New title", type: "invalidate-title" }]);
  });

  it("emits a cache-write effect on session-status", () => {
    const { effects, state } = applyStreamEvent(initialStreamState(), {
      isRunning: true,
      type: "session-status",
    });

    expect(state.serverIsRunning).toBe(true);
    expect(effects).toEqual([{ isRunning: true, type: "cache-session-status" }]);
  });

  it("records the message on error", () => {
    const { state } = applyStreamEvent(initialStreamState(), {
      message: "boom",
      type: "error",
    });

    expect(state.streamError).toBe("boom");
  });

  it("routes user-message and wiki-recall through as effects-only, changing no state", () => {
    const before = initialStreamState();

    const userMessageResult = applyStreamEvent(before, {
      text: "hello",
      type: "user-message",
    });
    expect(userMessageResult.state).toBe(before);
    expect(userMessageResult.effects).toEqual([
      { text: "hello", type: "append-optimistic-user-message" },
    ]);

    const wikiRecallResult = applyStreamEvent(before, {
      content: "found stuff",
      type: "wiki-recall",
    });
    expect(wikiRecallResult.state).toBe(before);
    expect(wikiRecallResult.effects).toEqual([
      { content: "found stuff", type: "apply-wiki-recall" },
    ]);
  });

  it("leaves state untouched on complete, with no effects", () => {
    const before = initialStreamState();
    const result = applyStreamEvent(before, { type: "complete" });

    expect(result.state).toBe(before);
    expect(result.effects).toEqual([]);
  });

  it("records an open-review request with its comment and bumps the nonce", () => {
    let { state } = applyStreamEvent(initialStreamState(), {
      comment: null,
      target: { path: "a.ts", project: "semla" },
      type: "open-review",
    });
    expect(state.openReviewRequest).toEqual({
      comment: null,
      nonce: 1,
      target: { path: "a.ts", project: "semla" },
    });

    const comment = {
      body: { kind: "text" as const, text: "hi" },
      createdAt: "2026-01-01T00:00:00Z",
      endLine: 5,
      filePath: "a.ts",
      id: "c1",
      projectPath: "semla",
      startLine: 5,
    };
    ({ state } = applyStreamEvent(state, {
      comment,
      target: { path: "a.ts", project: "semla" },
      type: "open-review",
    }));
    expect(state.openReviewRequest).toEqual({
      comment,
      nonce: 2,
      target: { path: "a.ts", project: "semla" },
    });
  });
});

describe("resetForNewTurn", () => {
  it("clears per-turn fields but preserves serverTitle and wikiActive", () => {
    const active: TurnStreamState = {
      ...initialStreamState(),
      activeTool: "bash",
      liveRounds: [{ id: "r1", text: "hi" }],
      liveToolCalls: [{ id: "c1", createdAt: "t", name: "bash" } as never],
      pendingFeatureSpec: true,
      pendingQuestion: { id: "q1", questions: [] } as never,
      serverTitle: "Existing title",
      streamError: "old error",
      wikiActive: true,
      workflowSnapshot: { agentCount: 1 } as never,
    };

    const reset = resetForNewTurn(active);

    expect(reset).toMatchObject({
      activeTool: undefined,
      liveRounds: [],
      liveToolCalls: [],
      pendingFeatureSpec: false,
      pendingQuestion: null,
      streamError: undefined,
      workflowSnapshot: undefined,
    });
    expect(reset.serverTitle).toBe("Existing title");
    expect(reset.wikiActive).toBe(true);
  });
});
