/**
 * Proof that `runPiPrompt` really does release its tightly-scoped cluster of
 * per-turn registrations through `TurnResources`, in the exact reverse of the
 * order it acquires them, and that the two session-keyed slots it deliberately
 * keeps *out* of that cluster (BRIDGE_RUN_STARTED and CURRENT_TURN) still
 * release afterwards, past the awaited span flush.
 *
 * turn-resources.test.ts covers the stack in isolation. What it cannot see is
 * the wiring: that each `push` sits beside its own acquisition and that
 * `release()` is reached on the happy path. That only existed inside a
 * `finally` reachable with a live provider and Supabase, which is why every
 * seam below is mocked at module level — the test asserts an *ordering*, so
 * each disposer records a label on one shared array and the array is the
 * assertion.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  BRIDGE_RUN_STARTED_KEY,
  CURRENT_TURN_KEY,
  createAgentSession,
  record,
  releases,
  retainedLiveSessions,
} = vi.hoisted(() => {
  /** Release labels in the order they actually happened. */
  const releases: string[] = [];

  return {
    BRIDGE_RUN_STARTED_KEY: Symbol.for("semla.bridge-run-started"),
    CURRENT_TURN_KEY: Symbol.for("semla.current-turn"),
    createAgentSession: vi.fn(),
    record: (label: string) => {
      releases.push(label);
    },
    releases,
    /** What `retainLiveSession` was handed, so its release can be identity-checked. */
    retainedLiveSessions: new Map<string, unknown>(),
  };
});

vi.mock("node:fs/promises", () => ({ mkdir: vi.fn(() => Promise.resolve()) }));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession,
  DefaultResourceLoader: class {
    reload() {
      return Promise.resolve();
    }
  },
  ModelRuntime: {
    create: vi.fn(() =>
      Promise.resolve({
        getAvailable: vi.fn(() => Promise.resolve([])),
        getModel: vi.fn(() => ({ id: "fake-model" })),
        setRuntimeApiKey: vi.fn(() => Promise.resolve()),
      }),
    ),
  },
  SessionManager: {
    open: vi.fn(() => ({
      branch: vi.fn(),
      getEntries: () => [],
      getLeafId: () => "leaf-1",
      getSessionId: () => "pi-runtime-1",
    })),
  },
}));

vi.mock("@mariozechner/pi-agent-core", () => ({ AGENT_TELEMETRY_SCHEMAS: [] }));

vi.mock("@/lib/pi/runtime/agent-dir", () => ({
  ensurePiAgentDirIsolated: vi.fn(),
}));

vi.mock("@/lib/pi/runtime/runtime-config", () => ({
  PI_AGENT_DIR: "/tmp/semla-test-agent",
  PI_SESSION_DIR: "/tmp/semla-test-sessions",
  PI_TOOLS: [] as readonly string[],
  WORKFLOW_SKILLS_PATH: "/tmp/semla-test-skills",
  getPiRuntimeConfig: () => ({ hostDevelopmentEnabled: false, sandboxed: true }),
}));

vi.mock("@/lib/pi/bridge/ask-user-bridge", () => ({
  registerNotifier: vi.fn(() => () => record("ask-user-notifier")),
}));

vi.mock("@/lib/pi/bridge/feature-spec-bridge", () => ({
  registerFeatureSpecNotifier: vi.fn(() => () => record("feature-spec-notifier")),
}));

vi.mock("@/lib/pi/session/live-sessions", () => ({
  getLiveSession: vi.fn(() => undefined),
  releaseLiveSession: vi.fn((semlaSessionId: string, session: unknown) => {
    // Identity-guarded exactly as the real registry is: a release for a
    // session that was never retained must not count as this turn's.
    if (retainedLiveSessions.get(semlaSessionId) === session) {
      record("live-session");
    }
  }),
  retainLiveSession: vi.fn((semlaSessionId: string, session: unknown) => {
    retainedLiveSessions.set(semlaSessionId, session);
  }),
}));

vi.mock("@/lib/pi/wiki/wiki-session-repo", () => ({
  clearSessionRepo: vi.fn(() => record("wiki-repo")),
  setSessionRepos: vi.fn(),
}));

vi.mock("@/lib/pi/telemetry/sink-registry", () => ({
  releaseSpanSink: vi.fn(() => record("span-sink")),
  retainSpanSink: vi.fn(),
}));

vi.mock("@/lib/pi/extension-loading/extension-contract", () => ({
  BRIDGE_RUN_STARTED: BRIDGE_RUN_STARTED_KEY,
  CURRENT_TURN: CURRENT_TURN_KEY,
  clearSessionSlot: vi.fn((key: symbol) => {
    if (key === BRIDGE_RUN_STARTED_KEY) record("slot:bridge-run-started");
    if (key === CURRENT_TURN_KEY) record("slot:current-turn");
  }),
  readSessionWorkflowManager: vi.fn(() => undefined),
  writeSessionSlot: vi.fn(),
}));

vi.mock("@/lib/pi/extension-loading/extension-health", () => ({
  recordExtensionLoad: vi.fn(),
}));

vi.mock("@/lib/pi/extension-loading/extension-manifest", () => ({
  EXTENSION_MANIFEST: [],
  assertExtensionLoad: vi.fn(),
  assertExtensionPathsExist: vi.fn(),
  assertManifestIsCoherent: vi.fn(),
  buildExtensionLoadReport: vi.fn(() => ({
    duplicatePaths: [],
    extensions: [],
    ok: true,
    unexpectedErrors: [],
  })),
  extensionFactoriesInLoadOrder: vi.fn(() => []),
  extensionPathsInLoadOrder: vi.fn(() => []),
  manifestForSession: vi.fn(() => []),
}));

vi.mock("@/lib/pi/extensions/architecture-awareness/placement-prompt", () => ({
  assertPlacementFileWithinSessionBudget: vi.fn(),
}));

vi.mock("@/lib/pi/extensions/architecture-awareness/settings", () => ({
  loadArchitectureAwarenessSettings: () => ({
    placementMaxTokens: 1000,
    placementPromptEnabled: false,
    placementToolsEnabled: false,
    specPersistenceEnabled: false,
  }),
}));

vi.mock("@/lib/pi/background/background-continuation", () => ({
  runBackgroundContinuation: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/pi/background/background-run-recovery", () => ({
  unfinishedBackgroundRunId: vi.fn(() => undefined),
}));
vi.mock("@/lib/pi/background/background-sessions", () => ({
  releaseBackgroundSession: vi.fn(),
}));
vi.mock("@/lib/pi/background/bg-continuation-registry", () => ({
  abortBackgroundContinuation: vi.fn(),
  armBackgroundContinuation: vi.fn(() => new AbortController().signal),
  hasBackgroundContinuation: vi.fn(() => false),
}));
vi.mock("@/lib/pi/background/turn-background-state", () => ({
  createTurnBackgroundState: () => ({
    deliveredDuringPrompt: false,
    hasBackgroundWorkflow: false,
    runId: undefined,
  }),
  // "idle" is the branch that does the least in the rest of `finally`: no
  // continuation handoff, no run finalisation.
  decideContinuation: vi.fn(() => ({ kind: "idle" })),
}));

vi.mock("@/lib/pi/bridge/bridge-run-progress", () => ({
  followBridgeRunProgress: vi.fn(),
}));

vi.mock("@/lib/pi/debug-writer", () => ({
  createSessionDebugWriter: () => new Proxy({}, { get: () => vi.fn() }),
}));

vi.mock("@/lib/pi/entry-persist-queue", () => ({
  queueEntries: vi.fn(() => 0),
  seedPersistedEntryIds: vi.fn(),
}));

vi.mock("@/lib/pi/prompt/system-prompt", () => ({
  DEFAULT_SYSTEM_PROMPT: "system",
}));

vi.mock("@/lib/pi/session/session-branch", () => ({
  applyBranchTarget: vi.fn(),
  resolveBranchTarget: vi.fn(),
}));

vi.mock("@/lib/pi/session/session-cwd", () => ({
  isProjectAnchored: () => true,
  resolveSessionCwd: () => "/workspace/proj",
}));

vi.mock("@/lib/pi/session/session-event-router", () => ({
  createTurnEventRouter: () => ({
    announceBackgroundRun: vi.fn(),
    claimBridgeRun: vi.fn(() => false),
    onSessionEvent: vi.fn(),
    persistBridgeSnapshot: vi.fn(),
  }),
}));

vi.mock("@/lib/pi/session/session-log", () => ({
  detach: vi.fn(),
  sessionLog: vi.fn(),
  sessionWarn: vi.fn(),
}));

vi.mock("@/lib/pi/session/session-meta", () => ({ writeSessionMeta: vi.fn() }));

vi.mock("@/lib/pi/session/session-persistence", () => ({
  createSessionFile: vi.fn(() => Promise.resolve("/tmp/session.jsonl")),
  ensurePiSession: vi.fn(() => Promise.resolve({ id: "pi-session-row-1" })),
  fetchPersistedEntries: vi.fn(() => Promise.resolve([])),
  fetchStuckBackgroundRuns: vi.fn(() => Promise.resolve([])),
  finalizeBackgroundRun: vi.fn(() => Promise.resolve()),
  setSessionRunning: vi.fn(() => Promise.resolve()),
  updateSessionTitle: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/pi/session/session-stream-store", () => ({
  closeSessionStream: vi.fn(),
  isSessionStreamActive: vi.fn(() => false),
  openSessionStream: vi.fn(),
  publishSessionRunning: vi.fn(),
  publishToSessionStream: vi.fn(),
}));

vi.mock("@/lib/pi/session/session-turn-lock", () => ({
  takeTurnSlot: () => ({
    finish: vi.fn(),
    updateAbort: vi.fn(),
    waitForPrior: () => Promise.resolve(),
  }),
}));

vi.mock("@/lib/pi/session/session-usage-store", () => ({
  stampConversationUsage: vi.fn(),
  sumEntryUsage: vi.fn(() => ({})),
}));

vi.mock("@/lib/pi/session/session-wiki-stamp", () => ({ stampWikiRepo: vi.fn() }));

vi.mock("@/lib/pi/telemetry/host-recorder", () => ({
  createHostTelemetry: () => ({
    activeToolSpanId: () => null,
    stepEnded: vi.fn(),
    stepStarted: vi.fn(),
    toolEnded: vi.fn(),
    toolStarted: vi.fn(),
    turnEnded: vi.fn(),
    turnSpanId: null,
    turnStarted: vi.fn(),
  }),
}));

vi.mock("@/lib/pi/telemetry/schema", () => ({
  SEMLA_TELEMETRY_SCHEMA: { spans: {} },
}));

vi.mock("@/lib/pi/telemetry/span-publisher", () => ({
  createSpanPublisher: () => ({ pending: () => [] }),
}));

vi.mock("@/lib/pi/telemetry/span-sink", () => ({
  createSpanSink: () => ({
    counts: { dropped: 0, open: 0, recorded: 0 },
    openSpan: vi.fn(),
    spans: () => [],
    traceId: "trace-1",
  }),
  sensitiveAttributeKeys: () => new Set<string>(),
}));

vi.mock("@/lib/pi/telemetry/span-store", () => ({
  appendSpans: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/pi/workflow/workflow-delivery-message", () => ({
  finishedRunMessage: vi.fn(() => "done"),
}));

vi.mock("@/lib/pi/workflow/workflow-run-reader", () => ({
  isRunTerminal: vi.fn(() => true),
  readWorkflowRun: vi.fn(() => null),
}));

import { runPiPrompt } from "./session-service.ts";

const fakeSession = () => ({
  abort: vi.fn(() => Promise.resolve()),
  agent: { waitForIdle: vi.fn(() => Promise.resolve()) },
  bindExtensions: vi.fn(() => Promise.resolve()),
  dispose: vi.fn(),
  getActiveToolNames: vi.fn(() => [] as string[]),
  prompt: vi.fn(() => Promise.resolve()),
  sendCustomMessage: vi.fn(() => Promise.resolve()),
  sessionManager: { getEntries: () => [], getLeafId: () => "leaf-1" },
  setActiveToolsByName: vi.fn(),
  subscribe: vi.fn(() => () => record("subscription")),
});

beforeEach(() => {
  releases.length = 0;
  retainedLiveSessions.clear();
  createAgentSession.mockResolvedValue({
    extensionsResult: { errors: [], extensions: [] },
    session: fakeSession(),
  });
});

describe("runPiPrompt — per-turn resource release", () => {
  it("releases the tightly-scoped cluster in reverse acquisition order, then the session-keyed slots", async () => {
    await runPiPrompt({
      model: { modelId: "m", provider: "p" },
      onEvent: () => {},
      projects: ["proj"],
      semlaSessionId: "s1",
      text: "hello",
      tools: [],
      turnId: "turn-1",
    });

    // Acquisition order in runPiPrompt is: wiki repo, span sink, ask-user
    // notifier, feature-spec notifier, live session, event subscription — so
    // `TurnResources.release()` unwinds it exactly backwards. The two slots
    // follow, after the awaited span flush, because they are deliberately not
    // in the cluster.
    expect(releases).toEqual([
      "subscription",
      "live-session",
      "feature-spec-notifier",
      "ask-user-notifier",
      "span-sink",
      "wiki-repo",
      "slot:bridge-run-started",
      "slot:current-turn",
    ]);
  });
});
