/**
 * What a prompt turn does in response to the agent's event stream. None of this
 * was reachable by a test while it was an inline subscriber inside runPiPrompt:
 * the client events, the project links, and the background-run bookkeeping the
 * turn's final decision reads all had to be exercised through a real pi session
 * and a real workflow.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

const {
  attachWrittenProject,
  persistBackgroundWorkflowStart,
  persistWorkflowSnapshot,
  retainBackgroundSession,
  setSessionRepos,
} = vi.hoisted(() => ({
  attachWrittenProject: vi.fn(() => Promise.resolve(true)),
  persistBackgroundWorkflowStart: vi.fn(() => Promise.resolve()),
  persistWorkflowSnapshot: vi.fn(() => Promise.resolve()),
  retainBackgroundSession: vi.fn(),
  setSessionRepos: vi.fn(),
}));

vi.mock("@/lib/pi/background/background-sessions", () => ({ retainBackgroundSession }));
vi.mock("@/lib/pi/session/session-persistence", () => ({
  persistBackgroundWorkflowStart,
  persistWorkflowSnapshot,
}));
vi.mock("@/lib/pi/wiki/wiki-session-repo", () => ({ setSessionRepos }));
vi.mock("@/lib/pi/session/session-project-attach", async (importOriginal) => ({
  // writtenPath is pure and is the thing under test here, so it stays real.
  ...(await importOriginal<typeof import("./session-project-attach.ts")>()),
  attachWrittenProject,
}));

import type { SessionDebugWriter } from "../debug-writer.ts";
import type { PiSessionEvent } from "./session-events.ts";
import { createHostTelemetry } from "../telemetry/host-recorder.ts";
import { createSpanSink } from "../telemetry/span-sink.ts";
import { createTurnEventRouter } from "./session-event-router.ts";
import {
  createTurnBackgroundState,
  type TurnBackgroundState,
} from "../background/turn-background-state.ts";

const debugStub = () =>
  new Proxy({} as SessionDebugWriter, { get: () => () => {} });

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const setup = (state: TurnBackgroundState = createTurnBackgroundState()) => {
  const emitted: PiSessionEvent[] = [];
  const attachedThisTurn = new Set<string>();
  const session = { dispose: vi.fn() };
  // A real sink and recorder, not a stub: the tool spans are derived from the
  // same events asserted below, and a wiring mistake there records nothing
  // while every other assertion still passes.
  const sink = createSpanSink("00000000-0000-4000-8000-00000000e1e1");
  const host = createHostTelemetry(sink, { piSessionId: "pi-runtime-1" });
  host.turnStarted();
  const router = createTurnEventRouter({
    agentCwd: "/w/proj",
    attachedThisTurn,
    debug: debugStub(),
    emit: (event) => emitted.push(event),
    host,
    piRuntimeSessionId: "pi-runtime-1",
    semlaSessionId: "s1",
    session,
    state,
    turnId: "20260101T000000000Z-aaaaaaaa",
    turnRepoSlugs: () => ["semla", ...attachedThisTurn],
  });

  return { attachedThisTurn, emitted, host, router, session, sink, state };
};

/** The fields the router reads; the SDK's event carries far more. */
const event = (value: Record<string, unknown>) => value as AgentSessionEvent;

/** The message_start that opens an assistant round trip — real event ordering always has one before any message_update or tool_execution_start/end for that round. */
const assistantMessageStart = () =>
  event({ message: { role: "assistant" }, type: "message_start" });

const toolStart = (overrides: Record<string, unknown> = {}) =>
  event({
    args: {},
    toolCallId: "call-1",
    toolName: "read",
    type: "tool_execution_start",
    ...overrides,
  });

const toolEnd = (overrides: Record<string, unknown> = {}) =>
  event({
    isError: false,
    result: {},
    toolCallId: "call-1",
    toolName: "read",
    type: "tool_execution_end",
    ...overrides,
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("assistant output", () => {
  it("forwards text deltas to the client, tagged with the round they belong to", () => {
    const { emitted, router } = setup();

    router.onSessionEvent(assistantMessageStart());
    router.onSessionEvent(
      event({
        assistantMessageEvent: { delta: "hello", type: "text_delta" },
        type: "message_update",
      }),
    );

    expect(emitted).toEqual([
      { roundId: "live-round-1", type: "round-start" },
      { delta: "hello", roundId: "live-round-1", type: "assistant-delta" },
    ]);
  });

  it("ignores other assistant events", () => {
    const { emitted, router } = setup();

    router.onSessionEvent(assistantMessageStart());
    router.onSessionEvent(
      event({
        assistantMessageEvent: { type: "thinking_delta" },
        type: "message_update",
      }),
    );

    expect(emitted).toEqual([{ roundId: "live-round-1", type: "round-start" }]);
  });

  /**
   * A turn is not one model reply — the model can say text, call a tool, say
   * more text, and so on, and each of those round trips has to be told apart
   * on the client so live rendering can interleave them the way the persisted
   * transcript already does. Without round-start there would be no way to
   * tell a delta or tool call arriving in the second round trip from one
   * arriving in the first.
   */
  it("assigns a new round id to each assistant message_start", () => {
    const { emitted, router } = setup();

    router.onSessionEvent(assistantMessageStart());
    router.onSessionEvent(assistantMessageStart());

    expect(emitted).toEqual([
      { roundId: "live-round-1", type: "round-start" },
      { roundId: "live-round-2", type: "round-start" },
    ]);
  });

  it("does not open a round for a tool-result message_start", () => {
    const { emitted, router } = setup();

    router.onSessionEvent(event({ message: { role: "toolResult" }, type: "message_start" }));

    expect(emitted).toEqual([]);
  });
});

describe("tool calls", () => {
  /**
   * The client places the call on the timeline from this event rather than
   * waiting for end-of-turn persistence, so it needs the id and a timestamp.
   */
  it("announces a tool start with the id the end event will reuse", () => {
    const { emitted, router } = setup();

    router.onSessionEvent(toolStart({ toolName: "bash" }));

    expect(emitted[0]).toMatchObject({
      toolCallId: "call-1",
      toolName: "bash",
      type: "tool-start",
    });
    expect(typeof (emitted[0] as { at: string }).at).toBe("string");
  });

  /**
   * A call made mid-turn belongs to whichever round trip is currently open,
   * so the client can group it with that round's text instead of every tool
   * call in the turn landing in one bucket at the end.
   */
  it("tags a tool call with the round trip that is currently open", () => {
    const { emitted, router } = setup();

    router.onSessionEvent(assistantMessageStart());
    router.onSessionEvent(toolStart());
    router.onSessionEvent(toolEnd());

    expect(emitted).toMatchObject([
      { roundId: "live-round-1", type: "round-start" },
      { roundId: "live-round-1", type: "tool-start" },
      { roundId: "live-round-1", type: "tool-end" },
    ]);
  });

  it("tags a second round trip's tool call differently from the first's", () => {
    const { emitted, router } = setup();

    router.onSessionEvent(assistantMessageStart());
    router.onSessionEvent(toolStart({ toolCallId: "call-1" }));
    router.onSessionEvent(toolEnd({ toolCallId: "call-1" }));
    router.onSessionEvent(assistantMessageStart());
    router.onSessionEvent(toolStart({ toolCallId: "call-2" }));

    const toolEvents = emitted.filter(
      (e): e is Extract<PiSessionEvent, { type: "tool-start" }> => e.type === "tool-start",
    );
    expect(toolEvents.map((e) => e.roundId)).toEqual([
      "live-round-1",
      "live-round-2",
    ]);
  });

  it("reports whether the call failed", () => {
    const { emitted, router } = setup();

    router.onSessionEvent(toolEnd({ isError: true }));

    expect(emitted[0]).toMatchObject({ isError: true, type: "tool-end" });
  });

  /**
   * The persisted transcript only exists after the turn ends, so without this
   * the drawer showed no response for a call clicked while it was still
   * streaming — or just after it finished, before the refetch landed.
   */
  it("carries the tool's response text on tool-end, matching what the persisted transcript will show", () => {
    const { emitted, router } = setup();

    router.onSessionEvent(
      toolEnd({ result: { content: [{ text: "total 0\ndrwxr-xr-x", type: "text" }] } }),
    );

    expect(emitted[0]).toMatchObject({
      resultText: "total 0\ndrwxr-xr-x",
      type: "tool-end",
    });
    expect((emitted[0] as { errorText?: string }).errorText).toBeUndefined();
  });

  it("reports the response text as errorText when the call failed", () => {
    const { emitted, router } = setup();

    router.onSessionEvent(
      toolEnd({
        isError: true,
        result: { content: [{ text: "no such file", type: "text" }] },
      }),
    );

    expect(emitted[0]).toMatchObject({
      errorText: "no such file",
      isError: true,
      resultText: "no such file",
      type: "tool-end",
    });
  });

  it("omits resultText when the tool returned no text content", () => {
    const { emitted, router } = setup();

    router.onSessionEvent(toolEnd({ result: {} }));

    expect((emitted[0] as { resultText?: string }).resultText).toBeUndefined();
  });
});

/**
 * A file in a project was actually changed, so the session relates to that
 * project. The path is only on the start event and success only on the end
 * event, so the two are bridged by toolCallId.
 */
describe("project links", () => {
  it("attaches the project a successful write touched", async () => {
    const { router } = setup();

    router.onSessionEvent(
      toolStart({ args: { path: "/w/proj/a.ts" }, toolName: "write" }),
    );
    router.onSessionEvent(toolEnd({ toolName: "write" }));
    await flush();

    expect(attachWrittenProject).toHaveBeenCalledWith(
      "s1",
      "/w/proj/a.ts",
      expect.any(Set),
      "/w/proj",
    );
  });

  /**
   * The agent runs in its anchor project, not the workspace root, so a
   * relative path has to be resolved against that — otherwise every relative
   * write attaches nothing. See session-cwd.ts.
   */
  it("hands the agent's cwd over so a relative write resolves", async () => {
    const { router } = setup();

    router.onSessionEvent(
      toolStart({ args: { path: "src/a.ts" }, toolName: "write" }),
    );
    router.onSessionEvent(toolEnd({ toolName: "write" }));
    await flush();

    expect(attachWrittenProject).toHaveBeenCalledWith(
      "s1",
      "src/a.ts",
      expect.any(Set),
      "/w/proj",
    );
  });

  // The whole reason the path is held rather than attached on the start event.
  it("does not attach the project a failed edit aimed at", async () => {
    const { router } = setup();

    router.onSessionEvent(
      toolStart({ args: { path: "/w/proj/a.ts" }, toolName: "edit" }),
    );
    router.onSessionEvent(toolEnd({ isError: true, toolName: "edit" }));
    await flush();

    expect(attachWrittenProject).not.toHaveBeenCalled();
  });

  it("ignores a read-only tool", async () => {
    const { router } = setup();

    router.onSessionEvent(toolStart({ args: { path: "/w/proj/a.ts" } }));
    router.onSessionEvent(toolEnd());
    await flush();

    expect(attachWrittenProject).not.toHaveBeenCalled();
  });

  /**
   * A page captured after the agent strays into a second repo should say so, so
   * the repo set is republished rather than left until the next turn.
   */
  it("republishes the turn's repos once the link is written", async () => {
    const { router } = setup();

    router.onSessionEvent(
      toolStart({ args: { path: "/w/proj/a.ts" }, toolName: "write" }),
    );
    router.onSessionEvent(toolEnd({ toolName: "write" }));
    await flush();

    expect(setSessionRepos).toHaveBeenCalledWith("pi-runtime-1", ["semla"]);
  });

  // Two writes to the same file in a turn must not confuse the pending map.
  it("does not reattach on a second end event for the same call", async () => {
    const { router } = setup();

    router.onSessionEvent(
      toolStart({ args: { path: "/w/proj/a.ts" }, toolName: "write" }),
    );
    router.onSessionEvent(toolEnd({ toolName: "write" }));
    router.onSessionEvent(toolEnd({ toolName: "write" }));
    await flush();

    expect(attachWrittenProject).toHaveBeenCalledTimes(1);
  });
});

describe("code_map", () => {
  it("forwards the structured map verbatim", () => {
    const { emitted, router } = setup();
    const map = {
      edges: [],
      nodes: [
        {
          external: false,
          file: "src/a.ts",
          id: "a",
          line: 1,
          name: "a",
        },
      ],
      root: "a",
    };

    router.onSessionEvent(
      toolEnd({
        result: { details: { map, type: "code-map" } },
        toolName: "code_map",
      }),
    );

    expect(emitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          map: expect.objectContaining({ root: "a" }),
          type: "code-map",
        }),
      ]),
    );
  });

  it("emits nothing when the result carries no map", () => {
    const { emitted, router } = setup();

    router.onSessionEvent(
      toolEnd({ result: { details: {} }, toolName: "code_map" }),
    );

    expect(emitted.some((e) => e.type === "code-map")).toBe(false);
  });
});

describe("background runs", () => {
  const backgroundResult = (runId: string) => ({
    details: { background: true, runId },
  });

  it("records the run as this turn's, so the turn stays alive for it", () => {
    const { router, state } = setup();

    router.onSessionEvent(
      toolEnd({ result: backgroundResult("run-1"), toolName: "workflow" }),
    );

    expect(state).toMatchObject({
      hasBackgroundWorkflow: true,
      runId: "run-1",
    });
  });

  it("retains the session under the run id and announces the start", () => {
    const { emitted, router, session } = setup();

    router.onSessionEvent(
      toolEnd({ result: backgroundResult("run-1"), toolName: "workflow" }),
    );

    expect(retainBackgroundSession).toHaveBeenCalledWith("run-1", session);
    expect(persistBackgroundWorkflowStart).toHaveBeenCalledWith("s1", "run-1");
    expect(emitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: "run-1", type: "workflow-started" }),
      ]),
    );
  });

  it("leaves a foreground workflow out of the turn's background state", () => {
    const { router, state } = setup();

    router.onSessionEvent(
      toolEnd({ result: { details: { agents: [] } }, toolName: "workflow" }),
    );

    expect(state.hasBackgroundWorkflow).toBe(false);
    expect(retainBackgroundSession).not.toHaveBeenCalled();
  });

  /**
   * Pi delivers a result inside the prompt turn when the workflow finishes
   * before the turn does. The turn's final decision reads this to tell that
   * case from a run it still has to wait for.
   */
  it("notes a workflow result delivered inside the turn", () => {
    const { router, state } = setup();

    router.onSessionEvent(
      event({
        message: { customType: "workflow-result", role: "custom" },
        type: "message_start",
      }),
    );

    expect(state.deliveredDuringPrompt).toBe(true);
  });

  it("does not mistake an ordinary message for a delivery", () => {
    const { router, state } = setup();

    router.onSessionEvent(
      event({ message: { role: "assistant" }, type: "message_start" }),
    );

    expect(state.deliveredDuringPrompt).toBe(false);
  });
});

describe("wiki recall", () => {
  it("forwards the wiki extension's recall content live, before the turn ends", () => {
    const { emitted, router } = setup();

    router.onSessionEvent(
      event({
        message: {
          content: "## Relevant Wiki Knowledge\n\n1. [[concepts/foo]]",
          customType: "wiki-recall-context",
          role: "custom",
        },
        type: "message_start",
      }),
    );

    expect(emitted).toEqual([
      {
        content: "## Relevant Wiki Knowledge\n\n1. [[concepts/foo]]",
        type: "wiki-recall",
      },
    ]);
  });

  it("emits nothing when recall matched no pages", () => {
    // formatRecallContext/buildAgentStartInjection never send an empty custom
    // message — no result means no message at all — but the router should
    // not surface a blank badge if it ever did.
    const { emitted, router } = setup();

    router.onSessionEvent(
      event({
        message: { content: "", customType: "wiki-recall-context", role: "custom" },
        type: "message_start",
      }),
    );

    expect(emitted.some((e) => e.type === "wiki-recall")).toBe(false);
  });

  it("ignores a custom message of a different customType", () => {
    const { emitted, router } = setup();

    router.onSessionEvent(
      event({
        message: {
          content: "Wiki active",
          customType: "wiki-session-notice",
          role: "custom",
        },
        type: "message_start",
      }),
    );

    expect(emitted.some((e) => e.type === "wiki-recall")).toBe(false);
  });
});

/**
 * The bash tool reports a running command's output through the same
 * `tool_execution_update` channel the workflow uses for snapshots, and it was
 * previously filtered out here. See the "bash-output" event in
 * session-events.ts.
 */
describe("agent bash output", () => {
  it("republishes a running command's output", () => {
    const { emitted, router } = setup();

    router.onSessionEvent(
      event({
        partialResult: { content: [{ text: "line one\n", type: "text" }] },
        toolCallId: "call-1",
        toolName: "bash",
        type: "tool_execution_update",
      }),
    );

    expect(emitted).toEqual([
      { output: "line one\n", toolCallId: "call-1", type: "bash-output" },
    ]);
  });

  it("drops the empty frame the tool emits before the command starts", () => {
    const { emitted, router } = setup();

    router.onSessionEvent(
      event({
        partialResult: { content: [] },
        toolCallId: "call-1",
        toolName: "bash",
        type: "tool_execution_update",
      }),
    );

    expect(emitted).toEqual([]);
  });

  it("ignores progress from a tool that is not bash", () => {
    const { emitted, router } = setup();

    router.onSessionEvent(
      event({
        partialResult: { content: [{ text: "noise", type: "text" }] },
        toolCallId: "call-1",
        toolName: "read",
        type: "tool_execution_update",
      }),
    );

    expect(emitted.some((e) => e.type === "bash-output")).toBe(false);
  });
});

describe("workflow snapshots", () => {
  const snapshotResult = { details: { agents: [{ id: 1, status: "running" }] } };

  it("persists and emits progress while the workflow runs", () => {
    const { emitted, router } = setup();

    router.onSessionEvent(
      event({
        partialResult: snapshotResult,
        toolName: "workflow",
        type: "tool_execution_update",
      }),
    );

    expect(persistWorkflowSnapshot).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ agents: expect.any(Array) }),
      "foreground",
    );
    expect(emitted.some((e) => e.type === "workflow-snapshot")).toBe(true);
  });

  it("ignores a partial result that is not a snapshot", () => {
    const { emitted, router } = setup();

    router.onSessionEvent(
      event({
        partialResult: { details: {} },
        toolName: "workflow",
        type: "tool_execution_update",
      }),
    );

    expect(persistWorkflowSnapshot).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
  });

  it("ignores progress from a tool that is not the workflow", () => {
    const { router } = setup();

    router.onSessionEvent(
      event({
        partialResult: snapshotResult,
        toolName: "bash",
        type: "tool_execution_update",
      }),
    );

    expect(persistWorkflowSnapshot).not.toHaveBeenCalled();
  });

  /**
   * A snapshot from a bridge-dispatched run is persisted but not emitted: the
   * workflow panel reads those from Supabase, and emitting them would put a
   * run the conversation never started onto its timeline.
   */
  it("persists a bridge snapshot without emitting it", () => {
    const { emitted, router } = setup();

    router.persistBridgeSnapshot(snapshotResult, "bridge-run");

    expect(persistWorkflowSnapshot).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ runId: "bridge-run" }),
      "background",
    );
    expect(emitted).toEqual([]);
  });
});

describe("claimBridgeRun", () => {
  it("claims an unclaimed turn and retains the session", () => {
    const { router, session } = setup();

    expect(router.claimBridgeRun("bridge-run")).toBe(true);
    expect(retainBackgroundSession).toHaveBeenCalledWith("bridge-run", session);
  });

  // The agent's own workflow call already owns this turn.
  it("does not displace a run the workflow tool already reported", () => {
    const { router, state } = setup();
    router.onSessionEvent(
      toolEnd({
        result: { details: { background: true, runId: "run-1" } },
        toolName: "workflow",
      }),
    );
    vi.clearAllMocks();

    expect(router.claimBridgeRun("bridge-run")).toBe(false);
    expect(state.runId).toBe("run-1");
    expect(retainBackgroundSession).not.toHaveBeenCalled();
  });
});

describe("host spans", () => {
  it("records a tool call as a span under the turn", () => {
    const { host, router, sink } = setup();

    router.onSessionEvent(toolStart());
    router.onSessionEvent(toolEnd());

    const tool = sink.spans().find((span) => span.name === "pi.harness.tool");
    expect(tool?.attributes["pi.tool.name"]).toBe("read");
    expect(tool?.attributes["pi.tool.call_id"]).toBe("call-1");
    expect(tool?.attributes["pi.tool.is_error"]).toBe(false);
    expect(tool?.endTimeMs).not.toBeNull();
    // Nested, so a workflow started inside the turn reads as part of it.
    expect(tool?.parentSpanId).toBe(host.turnSpanId);
  });

  it("marks a failed call as an error", () => {
    const { router, sink } = setup();

    router.onSessionEvent(toolStart());
    router.onSessionEvent(toolEnd({ isError: true }));

    const tool = sink.spans().find((span) => span.name === "pi.harness.tool");
    expect(tool?.attributes["pi.tool.is_error"]).toBe(true);
    expect(tool?.status.status).toBe("error");
  });

  it("does not open a second span for a repeated end event", () => {
    const { router, sink } = setup();

    router.onSessionEvent(toolStart());
    router.onSessionEvent(toolEnd());
    router.onSessionEvent(toolEnd());

    expect(
      sink.spans().filter((span) => span.name === "pi.harness.tool"),
    ).toHaveLength(1);
  });

  it("keeps concurrent calls apart by call id", () => {
    const { router, sink } = setup();

    router.onSessionEvent(toolStart({ toolCallId: "a", toolName: "read" }));
    router.onSessionEvent(toolStart({ toolCallId: "b", toolName: "bash" }));
    router.onSessionEvent(toolEnd({ toolCallId: "b", toolName: "bash" }));

    const tools = sink.spans().filter((s) => s.name === "pi.harness.tool");
    expect(tools).toHaveLength(2);
    // The one that ended is closed; the one still running is not.
    expect(tools.find((s) => s.attributes["pi.tool.name"] === "bash")?.endTimeMs)
      .not.toBeNull();
    expect(tools.find((s) => s.attributes["pi.tool.name"] === "read")?.endTimeMs)
      .toBeNull();
  });
});

describe("model round trip spans", () => {
  const msg = (type: string, role: string, usage?: unknown) =>
    event({ message: { role, ...(usage ? { usage } : {}) }, type });

  it("spans an assistant message from start to end", () => {
    const { host, router, sink } = setup();

    router.onSessionEvent(msg("message_start", "assistant"));
    router.onSessionEvent(
      msg("message_end", "assistant", {
        cost: { total: 0.02 },
        totalTokens: 1_200,
      }),
    );

    const step = sink.spans().find((s) => s.name === "pi.harness.step");
    expect(step?.parentSpanId).toBe(host.turnSpanId);
    expect(step?.attributes["gen_ai.usage.total_tokens"]).toBe(1_200);
    expect(step?.attributes["gen_ai.usage.cost"]).toBe(0.02);
    expect(step?.endTimeMs).not.toBeNull();
  });

  it("ignores messages that are not the assistant's", () => {
    const { router, sink } = setup();

    // A tool result is appended as a message too, and it is not a round trip.
    router.onSessionEvent(msg("message_start", "toolResult"));
    router.onSessionEvent(msg("message_start", "user"));

    expect(sink.spans().filter((s) => s.name === "pi.harness.step")).toHaveLength(
      0,
    );
  });

  it("records one span per round trip in a multi-step turn", () => {
    const { router, sink } = setup();

    for (let i = 0; i < 3; i += 1) {
      router.onSessionEvent(msg("message_start", "assistant"));
      router.onSessionEvent(msg("message_end", "assistant"));
    }

    expect(sink.spans().filter((s) => s.name === "pi.harness.step")).toHaveLength(
      3,
    );
  });
});

/**
 * Derived here rather than on the client because the client cannot: `getParams`
 * keeps only scalar arguments and `tool-end` carries no `details`, so an edit's
 * changed line never reaches the browser. Deriving in two places would also let
 * the follow mode and the history disagree about what the agent just did.
 */
describe("file access", () => {
  const accessEvents = (emitted: PiSessionEvent[]) =>
    emitted.filter((e) => e.type === "file-access");

  it("reports what a read opened, with the lines it asked for", () => {
    const { emitted, router } = setup();

    router.onSessionEvent(assistantMessageStart());
    router.onSessionEvent(
      toolStart({ args: { limit: 40, offset: 100, path: "src/a.ts" } }),
    );
    router.onSessionEvent(toolEnd());

    const [reported] = accessEvents(emitted);
    expect(reported?.accesses).toMatchObject([
      {
        confidence: "exact",
        kind: "read",
        ranges: [{ end: 139, start: 100 }],
        tool: "read",
      },
    ]);
  });

  it("pairs the start event's arguments with the end event's details", () => {
    // The whole reason this runs at tool *end*: the path is only on the start
    // and `firstChangedLine` only on the end.
    const { emitted, router } = setup();

    router.onSessionEvent(assistantMessageStart());
    router.onSessionEvent(
      toolStart({ args: { path: "src/a.ts" }, toolName: "edit" }),
    );
    router.onSessionEvent(
      toolEnd({ result: { details: { firstChangedLine: 42 } }, toolName: "edit" }),
    );

    expect(accessEvents(emitted)[0]?.accesses).toMatchObject([
      { kind: "write", ranges: [{ end: 42, start: 42 }] },
    ]);
  });

  it("says nothing about a call that failed", () => {
    // Following the agent onto a path it could not open is worse than not
    // following it.
    const { emitted, router } = setup();

    router.onSessionEvent(assistantMessageStart());
    router.onSessionEvent(toolStart({ args: { path: "src/a.ts" } }));
    router.onSessionEvent(toolEnd({ isError: true }));

    expect(accessEvents(emitted)).toEqual([]);
  });

  it("says nothing about a tool that touches no file", () => {
    const { emitted, router } = setup();

    router.onSessionEvent(assistantMessageStart());
    router.onSessionEvent(
      toolStart({ args: { slug: "x" }, toolName: "wiki_ensure_page" }),
    );
    router.onSessionEvent(toolEnd({ toolName: "wiki_ensure_page" }));

    expect(accessEvents(emitted)).toEqual([]);
  });

  it("parses a shell command and marks what it found as inferred", () => {
    const { emitted, router } = setup();

    router.onSessionEvent(assistantMessageStart());
    router.onSessionEvent(
      toolStart({
        args: { command: "sed -n 10,20p src/a.ts" },
        toolName: "bash",
      }),
    );
    router.onSessionEvent(toolEnd({ toolName: "bash" }));

    expect(accessEvents(emitted)[0]?.accesses).toMatchObject([
      { confidence: "inferred", ranges: [{ end: 20, start: 10 }], tool: "bash" },
    ]);
  });

  it("attributes live accesses to the live turn, since none is persisted yet", () => {
    const { emitted, router } = setup();

    router.onSessionEvent(assistantMessageStart());
    router.onSessionEvent(toolStart({ args: { path: "src/a.ts" } }));
    router.onSessionEvent(toolEnd());

    expect(accessEvents(emitted)[0]?.accesses[0]?.turnId).toBe("\u2039live\u203a");
  });
});
