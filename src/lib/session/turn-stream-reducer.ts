/**
 * The turn stream's state, folded through one call rather than fourteen
 * inline handlers.
 *
 * `usePromptMutation` used to hold this state as ~14 separate `useState`
 * hooks, each written from its own event-specific handler inside a
 * `StreamHandlers` object built by a `useMemo`. That is the shape
 * `session-event-router.ts` had server-side before it was pulled out of
 * `runPiPrompt` — an inline subscriber mutating bindings a distant `finally`
 * block reads — and the same problem shows up here: a wrong tool-call merge
 * or a dropped span means reading the hook end to end rather than one
 * function.
 *
 * `applyStreamEvent(state, event)` is the single entry point. It returns the
 * next `TurnStreamState` plus a list of `TurnStreamEffect`s — data describing
 * a side effect (a query-cache write, a console push, an invalidation) that
 * only the hook, which actually holds the `QueryClient`, is allowed to run.
 * This keeps the reducer pure and testable with a scripted event sequence:
 * no query client, no fetch, no DOM.
 *
 * What this module deliberately does NOT absorb: `live-rounds.ts` and
 * `live-tool-calls.ts` already hold the pure fold logic for rounds and tool
 * calls (`applyRoundStart`, `applyRoundDelta`, `applyLiveToolEvent`), and
 * `liveRoundMessages`/`mergeToolCalls` derive UI-facing values from that
 * state from call sites this reducer does not own
 * (`client-session-component.tsx`, a trace test). Duplicating the fold logic
 * here just to satisfy "one reducer" would leave two implementations of the
 * same rule; this reducer calls out to them instead.
 */
import type { SessionToolCall } from "@/hooks/use-session-messages";
import type { AskUserPayload } from "@/lib/pi/bridge/ask-user-bridge";
import type { FileAccess } from "@/lib/pi/file-access/access-types";
import type { RecordedSpan } from "@/lib/pi/telemetry/span-sink";
import type { CodeMap } from "@/lib/code-map/types";
import type { OpenReviewTarget } from "@/lib/pi/review/open-review-result";
import type { ReviewComment } from "@/lib/review/review-comment-types";
import type { WorkflowSnapshot } from "@/types/workflow";
import {
  applyLiveToolEvent,
  type LiveToolEvent,
} from "@/lib/session/live-tool-calls";
import { applyRoundDelta, applyRoundStart, type LiveRound } from "@/lib/session/live-rounds";
import { startsWikiActivity } from "@/lib/wiki/wiki-activity";

/** The wire shape `readPiStream` decodes from the turn's SSE body. */
export type PiStreamEvent =
  | { text: string; type: "user-message" }
  | { content: string; type: "wiki-recall" }
  | { roundId: string; type: "round-start" }
  | { delta: string; roundId: string; type: "assistant-delta" }
  | { message: string; type: "error" }
  | LiveToolEvent
  | { runId: string; startedAt: string; type: "workflow-started" }
  | { snapshot: WorkflowSnapshot; type: "workflow-snapshot" }
  | { spans: readonly RecordedSpan[]; type: "spans" }
  | { map: CodeMap; type: "code-map" }
  | { target: OpenReviewTarget | null; comment: ReviewComment | null; type: "open-review" }
  | { output: string; toolCallId: string; type: "bash-output" }
  | { accesses: readonly FileAccess[]; type: "file-access" }
  | { payload: AskUserPayload; type: "ask-user-question" }
  | { type: "feature-spec-request" }
  | { title: string; type: "title-updated" }
  | { type: "session-status"; isRunning: boolean }
  | { type: "complete" };

/** Everything a turn's stream renders, in one place. */
export type TurnStreamState = {
  activeTool: string | undefined;
  codeMap: CodeMap | undefined;
  liveRounds: readonly LiveRound[];
  /**
   * The most recent `open_review` request this turn made, with a nonce so a
   * second identical request (e.g. "just open the panel" twice in a row,
   * where `target` is `null` both times) still changes this field and the
   * effect watching it fires again. Same convention as
   * `element-target-provider.tsx`'s `nonce`: the value alone cannot say
   * "this happened again", so a counter travels with it.
   */
  openReviewRequest:
    | { nonce: number; target: OpenReviewTarget | null; comment: ReviewComment | null }
    | undefined;
  liveToolCalls: readonly SessionToolCall[];
  pendingFeatureSpec: boolean;
  pendingQuestion: AskUserPayload | null;
  serverIsRunning: boolean;
  serverTitle: string | null;
  spansById: ReadonlyMap<string, RecordedSpan>;
  streamError: string | undefined;
  wikiActive: boolean;
  workflowSnapshot: WorkflowSnapshot | undefined;
};

/**
 * What a caller does with `serverTitle`/`serverIsRunning` before this
 * reducer runs at all, so the initial render (a page loaded with
 * `initialIsRunning`) does not start from a state this module invented.
 */
export function initialStreamState(options?: {
  serverIsRunning?: boolean;
}): TurnStreamState {
  return {
    activeTool: undefined,
    codeMap: undefined,
    liveRounds: [],
    liveToolCalls: [],
    openReviewRequest: undefined,
    pendingFeatureSpec: false,
    pendingQuestion: null,
    serverIsRunning: options?.serverIsRunning ?? false,
    serverTitle: null,
    spansById: new Map(),
    streamError: undefined,
    wikiActive: false,
    workflowSnapshot: undefined,
  };
}

/**
 * The reset every new turn needs: `onMutate` (a fresh prompt) and
 * `reconnectToStream` (re-attaching to one already running) used to repeat
 * the same five `setState(...)` calls independently. `serverTitle` and
 * `wikiActive` are deliberately left alone — the title the server derived
 * for this session and whether the wiki has been active in it do not reset
 * just because another turn started.
 */
export function resetForNewTurn(state: TurnStreamState): TurnStreamState {
  return {
    ...state,
    activeTool: undefined,
    liveRounds: [],
    liveToolCalls: [],
    pendingFeatureSpec: false,
    pendingQuestion: null,
    streamError: undefined,
    workflowSnapshot: undefined,
  };
}

/**
 * A side effect this reducer decided is needed, described as data rather
 * than performed. Every `queryClient` touch and console push the old
 * `StreamHandlers` object made inline now travels here instead, so the
 * reducer stays pure and the hook is the only place a `QueryClient` is ever
 * called.
 */
export type TurnStreamEffect =
  | { type: "append-optimistic-user-message"; text: string }
  | { content: string; type: "apply-wiki-recall" }
  | { event: LiveToolEvent; type: "cache-live-tool-call" }
  | { command: string; toolCallId: string; type: "console-bash-start"; at: string }
  | {
      at: string;
      isError: boolean;
      output?: string;
      toolCallId: string;
      type: "console-bash-end";
    }
  | { output: string; toolCallId: string; type: "console-bash-output" }
  | { spans: readonly RecordedSpan[]; type: "cache-spans" }
  | { accesses: readonly FileAccess[]; type: "cache-file-access" }
  /**
   * Both cache writes the old `onSessionStatus` handler made directly:
   * `sessionStatusKey(sessionId)` (the header badges, the agents panel) and
   * the sidebar's own `SESSION_STATUS_KEY` list, via `withSessionRunning`.
   * Neither is an invalidation — the handler always wrote the reading it
   * already had rather than asking the server to refetch it.
   */
  | { isRunning: boolean; type: "cache-session-status" }
  | { title: string; type: "invalidate-title" };

export type TurnStreamResult = {
  effects: readonly TurnStreamEffect[];
  state: TurnStreamState;
};

const unchanged = (
  state: TurnStreamState,
  effects: readonly TurnStreamEffect[] = [],
): TurnStreamResult => ({ effects, state });

/**
 * Fold one event from the turn's stream into the next state.
 *
 * One dispatch for every event kind `readPiStream` can hand it, including
 * `user-message` and `wiki-recall` — neither changes `TurnStreamState`, but
 * routing them through here too means the hook has exactly one call to make
 * per event rather than a reducer for most events and a handful of
 * standalone callbacks for the rest.
 */
export function applyStreamEvent(
  state: TurnStreamState,
  event: PiStreamEvent,
): TurnStreamResult {
  switch (event.type) {
    case "user-message":
      return unchanged(state, [
        { text: event.text, type: "append-optimistic-user-message" },
      ]);

    case "wiki-recall":
      return unchanged(state, [
        { content: event.content, type: "apply-wiki-recall" },
      ]);

    case "round-start":
      return unchanged({
        ...state,
        liveRounds: applyRoundStart(state.liveRounds, event),
      });

    case "assistant-delta":
      return unchanged({
        ...state,
        liveRounds: applyRoundDelta(state.liveRounds, event),
      });

    case "tool-start": {
      const effects: TurnStreamEffect[] = [
        { event, type: "cache-live-tool-call" },
      ];
      const command = event.params?.["command"];
      if (event.toolName === "bash" && command) {
        effects.push({
          at: event.at,
          command,
          toolCallId: event.toolCallId,
          type: "console-bash-start",
        });
      }
      return {
        effects,
        state: {
          ...state,
          activeTool: event.toolName,
          liveToolCalls: applyLiveToolEvent(state.liveToolCalls, event),
          // Latches true the first time a wiki-activity tool is seen; never
          // resets for the lifetime of this state, same as the old
          // wikiActiveRef/wikiActive pair in usePromptMutation.
          wikiActive: state.wikiActive || startsWikiActivity(event.toolName),
        },
      };
    }

    case "tool-end": {
      const effects: TurnStreamEffect[] = [
        { event, type: "cache-live-tool-call" },
      ];
      if (event.toolName === "bash") {
        effects.push({
          at: event.at,
          isError: event.isError,
          toolCallId: event.toolCallId,
          type: "console-bash-end",
          ...(event.errorText ?? event.resultText
            ? { output: event.errorText ?? event.resultText }
            : {}),
        });
      }
      return {
        effects,
        state: {
          ...state,
          activeTool: undefined,
          liveToolCalls: applyLiveToolEvent(state.liveToolCalls, event),
          pendingFeatureSpec:
            event.toolName === "capture_feature_spec"
              ? false
              : state.pendingFeatureSpec,
          pendingQuestion:
            event.toolName === "ask_user" ? null : state.pendingQuestion,
        },
      };
    }

    case "bash-output":
      return unchanged(state, [
        {
          output: event.output,
          toolCallId: event.toolCallId,
          type: "console-bash-output",
        },
      ]);

    case "ask-user-question":
      return unchanged({ ...state, pendingQuestion: event.payload });

    case "feature-spec-request":
      return unchanged({ ...state, pendingFeatureSpec: true });

    case "workflow-snapshot":
      return unchanged({ ...state, workflowSnapshot: event.snapshot });

    case "workflow-started":
      return unchanged({
        ...state,
        workflowSnapshot: {
          agentCount: 0,
          agents: [],
          doneCount: 0,
          errorCount: 0,
          name: "Background workflow",
          phases: [],
          runId: event.runId,
          runningCount: 0,
          startedAt: event.startedAt,
        },
      });

    case "spans": {
      const nextSpansById = new Map(state.spansById);
      for (const span of event.spans) nextSpansById.set(span.spanId, span);
      return {
        effects: [{ spans: event.spans, type: "cache-spans" }],
        state: { ...state, spansById: nextSpansById },
      };
    }

    case "code-map":
      return unchanged({ ...state, codeMap: event.map });

    case "open-review":
      return unchanged({
        ...state,
        openReviewRequest: {
          comment: event.comment,
          nonce: (state.openReviewRequest?.nonce ?? 0) + 1,
          target: event.target,
        },
      });

    case "file-access":
      return unchanged(state, [
        { accesses: event.accesses, type: "cache-file-access" },
      ]);

    case "title-updated":
      return {
        effects: [{ title: event.title, type: "invalidate-title" }],
        state: { ...state, serverTitle: event.title },
      };

    case "session-status":
      return {
        effects: [{ isRunning: event.isRunning, type: "cache-session-status" }],
        state: { ...state, serverIsRunning: event.isRunning },
      };

    case "error":
      return unchanged({ ...state, streamError: event.message });

    case "complete":
      return unchanged(state);

    default:
      return unchanged(state);
  }
}

