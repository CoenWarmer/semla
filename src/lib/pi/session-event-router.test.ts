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

vi.mock("@/lib/pi/background-sessions", () => ({ retainBackgroundSession }));
vi.mock("@/lib/pi/session-persistence", () => ({
  persistBackgroundWorkflowStart,
  persistWorkflowSnapshot,
}));
vi.mock("@/lib/pi/wiki-session-repo", () => ({ setSessionRepos }));
vi.mock("@/lib/pi/session-project-attach", async (importOriginal) => ({
  // writtenPath is pure and is the thing under test here, so it stays real.
  ...(await importOriginal<typeof import("./session-project-attach.ts")>()),
  attachWrittenProject,
}));

import type { SessionDebugWriter } from "./debug-writer.ts";
import type { PiSessionEvent } from "./session-events.ts";
import { createHostTelemetry } from "./telemetry/host-recorder.ts";
import { createSpanSink } from "./telemetry/span-sink.ts";
import { createTurnEventRouter } from "./session-event-router.ts";
import {
  createTurnBackgroundState,
  type TurnBackgroundState,
} from "./turn-background-state.ts";

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
    turnRepoSlugs: () => ["semla", ...attachedThisTurn],
  });

  return { attachedThisTurn, emitted, host, router, session, sink, state };
};

/** The fields the router reads; the SDK's event carries far more. */
const event = (value: Record<string, unknown>) => value as AgentSessionEvent;

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
  it("forwards text deltas to the client", () => {
    const { emitted, router } = setup();

    router.onSessionEvent(
      event({
        assistantMessageEvent: { delta: "hello", type: "text_delta" },
        type: "message_update",
      }),
    );

    expect(emitted).toEqual([{ delta: "hello", type: "assistant-delta" }]);
  });

  it("ignores other assistant events", () => {
    const { emitted, router } = setup();

    router.onSessionEvent(
      event({
        assistantMessageEvent: { type: "thinking_delta" },
        type: "message_update",
      }),
    );

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

  it("reports whether the call failed", () => {
    const { emitted, router } = setup();

    router.onSessionEvent(toolEnd({ isError: true }));

    expect(emitted[0]).toMatchObject({ isError: true, type: "tool-end" });
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
