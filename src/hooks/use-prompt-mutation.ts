import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  sessionMessagesQueryKey,
  type SessionMessage,
  type SessionMessagesResult,
  type SessionToolCall,
} from "@/hooks/use-session-messages";
import { promptFailureMessage } from "@/lib/prompt-failure";
import { truncateAtMessage } from "@/lib/session/session-fork";
import {
  fetchSessionSpans,
  mergeSpans,
  sessionSpansKey,
} from "@/lib/trace/session-spans";
import { handOffStreamedAnswer } from "@/lib/session/streamed-answer-handoff";
import { fileContentQueryKeyPrefix, reviewQueryKey } from "@/hooks/use-review";
import {
  projectChangeInvalidations,
  sessionProjectsKey,
} from "@/hooks/use-session-projects";
import {
  fetchSingleSessionStatus,
  SESSION_STATUS_KEY,
  sessionStatusKey,
  withSessionRunning,
  type SessionStatus,
} from "@/lib/session/session-status";
import { sessionLiveAccessesKey, sessionLiveToolCallsKey } from "@/lib/session/session-live-state";
import {
  applyStreamEvent,
  initialStreamState,
  resetForNewTurn,
  type PiStreamEvent,
  type TurnStreamEffect,
} from "@/lib/session/turn-stream-reducer";
import { applyTurnEffects } from "@/lib/session/turn-stream-effects";

export type PromptModel = {
  modelId: string;
  provider: string;
};

type PromptInput = {
  /**
   * Present when this prompt is also what creates the session: /sessions/new
   * mints the id and navigates without waiting, so the first prompt is the
   * request that brings the session into being. One round trip rather than two
   * before the agent starts.
   */
  create?: { project: string | null; title: string };
  /**
   * Set when this prompt replaces an earlier one. The server moves the session
   * leaf to that entry's parent, so this turn supersedes it rather than being
   * appended after the answer it corrects.
   */
  editEntryId?: string;
  /**
   * The branch this prompt continues from, when it is not the session's
   * default — the entry the client had open (from `?leaf=`) at the moment the
   * prompt was sent. See docs/plans/branching-sessions.md §2: which branch a
   * turn lands on travels with the request that starts it, not as state the
   * server remembers between requests.
   */
  leafId?: string;
  model: PromptModel;
  text: string;
  tools: string[];
};

// Flip to true to trace the prompt lifecycle in the browser console: every
// stage of the mutation, the MutationCache transitions behind it, and the
// mount/unmount of each hook instance. Kept because this app has hit several
// "turn finished but the UI never settled" bugs, and the useMutation observer
// detaching from an in-flight mutation is invisible without the cache events.
const TRACE_PROMPT_LIFECYCLE = false;
let traceSeq = 0;
const trace = (stage: string, data?: Record<string, unknown>) => {
  if (!TRACE_PROMPT_LIFECYCLE) return;
  const at = new Date().toISOString().slice(11, 23);
  console.log(`[prompt-trace ${at}] ${stage}`, data ?? "");
};

/**
 * What `onSettled` calls to hand the client back onto the live stream when
 * the turn that just ended was not actually the end of the server's work.
 *
 * The POST body stream `mutationFn` reads from is a one-shot: it closes the
 * instant this turn's model loop goes idle, even when the server is about to
 * carry on without us — a background workflow starting its next phase, or
 * spawning its next agent (see #13). `serverIsRunning` is the last
 * `session-status` push that same stream delivered before closing —
 * read off `stateRef.current` rather than the `state` this hook renders, for
 * the same reason the old `serverIsRunningRef` existed: a `session-status`
 * push can commit *during* `mutationFn`'s stream read, and a closure captured
 * when the mutation's callbacks were bound would otherwise see the pre-push
 * reading. `stateRef` is not a bespoke ref grown for this one field — every
 * dispatched stream event writes it synchronously before `setState` queues
 * the render — so this reads correctly for the same structural reason, not
 * because of a bookkeeping ref maintained solely for this call.
 * `reconnectToStream` is the same path a page loaded mid-turn already uses to
 * attach to that live stream — it self-guards against a second concurrent
 * subscription, so calling it is safe even if one happens to already be open.
 *
 * Exported as a standalone function (rather than inlined in `onSettled`) so
 * the wiring can be pinned by a test without a DOM: the hook itself needs
 * React to run at all, but this decision does not.
 */
export const reconnectIfStillRunning = (
  serverIsRunning: boolean,
  reconnectToStream: () => void,
): void => {
  if (serverIsRunning) reconnectToStream();
};

/**
 * Whether a mutation's `onError`/`onSettled` callback belongs to the call
 * that is still current, and so may touch the shared message cache and
 * `stateRef`.
 *
 * The bug this closes: an `ask_user` turn a newer prompt supersedes does not
 * have its `mutationFn` cancelled on the client — the server-side abort
 * (`session-turn-lock.ts`) runs underneath it, but the superseded turn's
 * SSE stream stays open server-side until the prompt route's own `finally`
 * chain (residual capture, artifact drain) finishes, which can be *after*
 * the newer turn has already completed and rendered its own reply. When
 * that superseded stream finally closes, its `mutationFn` throws (the abort
 * surfaces as a `{type:"error"}` SSE event) and its `onError` restored a
 * `previousMessages` snapshot taken before it ever ran — overwriting the
 * newer, already-correct transcript with no further refetch to fix it, so
 * the operator's new prompt disappeared from the conversation until a
 * manual reload re-fetched from disk.
 *
 * `context` is undefined only when the mutation failed before `onMutate`
 * ever returned (e.g. `queryClient.cancelQueries` itself throwing) — there
 * is no epoch to compare in that case, and no snapshot was captured either,
 * so the call is treated as current by default rather than silently
 * dropping a real failure.
 *
 * Exported standalone, same reason as `reconnectIfStillRunning` above: pinned
 * by a test with no DOM, independent of the hook's own React lifecycle.
 */
export const isCurrentMutation = (
  context: { epoch: number } | undefined,
  currentEpoch: number,
): boolean => !context || context.epoch === currentEpoch;

/**
 * Decode the turn's SSE body into `PiStreamEvent`s, handing each to `onEvent`
 * as it arrives.
 *
 * Deliberately dumb: parsing is all this does. What each event *means* —
 * which state changes, which query-cache writes, which console entries — is
 * `turn-stream-reducer.ts`'s job, dispatched by the caller. This function
 * used to also fan a `PiStreamEvent` out across a 14-method `StreamHandlers`
 * object; that fan-out is what the reducer now owns.
 */
const readPiStream = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onEvent: (event: PiStreamEvent) => void,
): Promise<Error | undefined> => {
  const decoder = new TextDecoder();
  let buffer = "";
  let piError: Error | undefined;

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });

    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";

    for (const event of events) {
      const data = event
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6);

      if (!data) continue;

      let piEvent: PiStreamEvent;
      try {
        piEvent = JSON.parse(data) as PiStreamEvent;
      } catch (parseError) {
        console.error("Malformed SSE event from Pi stream:", data, parseError);
        continue;
      }

      if (piEvent.type === "error") piError = new Error(piEvent.message);
      onEvent(piEvent);
    }

    if (done) break;
  }

  return piError;
};

export const usePromptMutation = (
  sessionId: string,
  initialIsRunning?: boolean,
  /**
   * The branch currently being viewed, from `?leaf=` — undefined for the
   * default/live view. Every cache read, write and invalidation this hook
   * does against the transcript has to agree with `useSessionMessages` on
   * which branch's entry that is, or a turn's optimistic bubble and its
   * eventual refetch would land in two different cache slots. See
   * sessionMessagesQueryKey's own doc for why the key varies by this.
   *
   * Named apart from the mutation's own per-submission `leafId` (the fork a
   * *prompt* continues from, in PromptInput below) on purpose: the two answer
   * different questions and `onMutate` destructures the latter from its
   * variables — a same-named parameter here would silently shadow it rather
   * than erroring, which is a mistake worth naming around rather than relying
   * on scoping rules to avoid.
   */
  viewingLeafId?: string | null,
  /**
   * When the turn `initialIsRunning` refers to started, per the session's
   * own record on disk. Anchors the elapsed-time counter to the turn's real
   * start on first render, so a page load mid-turn does not start it from
   * zero. `undefined`/`null` when nothing was running, or for a record
   * written before this field existed.
   */
  initialTurnStartedAt?: string | null,
) => {
  // Memoised: this array is a dependency of several callbacks below, and a
  // fresh one on every render would defeat their own memoisation — the tuple
  // form of sessionMessagesQueryKey returns a new array each call, the same
  // reason `messages` elsewhere in this codebase is never `?? []` inline.
  const messagesKey = useMemo(
    () => sessionMessagesQueryKey(sessionId, viewingLeafId),
    [sessionId, viewingLeafId],
  );
  const queryClient = useQueryClient();

  // Live turn state is mirrored into the query cache so layout-level
  // components (e.g. bottom-bar panels) can read it without a prop or portal.
  // See src/lib/session/session-live-state.ts for the keys and read hooks.

  /**
   * Tell the sidebar what this page already knows about its own session.
   *
   * The list poll is the sidebar's only source, and at its idle interval a
   * short turn can start and finish between two of them — so the row never
   * shows a spinner for a turn this page watched from beginning to end.
   * Writing the cache costs no request.
   */
  const setListRunning = useCallback(
    (isRunning: boolean) => {
      queryClient.setQueryData<SessionStatus[]>(SESSION_STATUS_KEY, (prev) =>
        withSessionRunning(prev, sessionId, isRunning),
      );
    },
    [queryClient, sessionId],
  );
  // Non-zero while a submit is in flight; >1 means overlapping submits, which
  // would leave isPending true off the newest one after the first settles.
  const inFlightRef = useRef(0);
  /**
   * Bumped by every `onMutate`, so `onError`/`onSettled` can tell whether the
   * call they belong to is still the latest one before touching shared state
   * (the message cache, `stateRef`).
   *
   * A prompt that supersedes a turn still waiting on `ask_user` does not
   * cancel that turn's own `mutationFn` on the client: the server-side abort
   * (`session-turn-lock.ts`) runs underneath it, but the superseded turn's
   * HTTP stream stays open server-side until its `finally` chain (residual
   * capture, artifact drain in the prompt route) finishes — which can be
   * after the newer turn has already completed. When that superseded stream
   * finally closes, its `mutationFn` throws (the abort surfaces as a
   * `{type:"error"}` SSE event) and its `onError` restored
   * `context.previousMessages` — a snapshot taken *before this call ever
   * ran* — over whatever the newer, already-finished turn had written. That
   * is the bug: the operator's new prompt renders, then vanishes, because a
   * stale mutation's error recovery overwrote it, and nothing re-fetches
   * until a manual reload. Guarding on this counter makes a superseded
   * call's `onError`/`onSettled` a no-op once a newer one has started.
   */
  const mutationEpochRef = useRef(0);
  // Identifies this hook instance, so a trace line can be attributed to the
  // component that is actually rendering the spinner.
  const [inst] = useState(() => Math.random().toString(36).slice(2, 7));

  /**
   * Everything the turn's stream renders, folded through
   * `applyStreamEvent` rather than through one `useState` per field — see
   * turn-stream-reducer.ts for the shape and why.
   *
   * `stateRef` mirrors `state` synchronously: every dispatched event writes
   * it before `setState` ever queues a render, so a callback that needs the
   * *current* reading rather than whatever this render closed over
   * (`onSettled`, below) reads the ref. This is the same structural fix the
   * old `serverIsRunningRef` was a one-field special case of.
   */
  const stateRef = useRef(
    initialStreamState({
      serverIsRunning: initialIsRunning ?? false,
      serverTurnStartedAt: initialTurnStartedAt ?? null,
    }),
  );
  const [state, setState] = useState(stateRef.current);

  /**
   * What this session has recorded, from disk and from the live stream.
   *
   * The query is what makes a reload keep its trace: live spans only ever
   * existed in the turn's stream, so without it the timeline falls back to the
   * derived one the moment the page refreshes.
   */
  const { data: persistedSpans } = useQuery({
    queryKey: sessionSpansKey(sessionId),
    queryFn: () => fetchSessionSpans(sessionId),
    // The file only grows through this page's own turns, which arrive on the
    // stream anyway. Nothing to poll for.
    staleTime: Number.POSITIVE_INFINITY,
  });

  const spans = useMemo(
    () => mergeSpans(persistedSpans ?? [], state.spansById),
    [persistedSpans, state.spansById],
  );

  /** See streamed-answer-handoff.ts for why the order here matters. */
  const handOffToTranscript = useCallback(
    () =>
      handOffStreamedAnswer({
        clearStreamed: () => {
          stateRef.current = { ...stateRef.current, liveRounds: [] };
          setState(stateRef.current);
        },
        loadTranscript: () =>
          queryClient.invalidateQueries({
            queryKey: messagesKey,
          }),
      }),
    [queryClient, messagesKey],
  );
  const reconnectAbortRef = useRef<AbortController | null>(null);

  /**
   * Run every effect `applyStreamEvent` asked for.
   *
   * The only place in this hook that touches `queryClient` on the turn
   * stream's behalf — the reducer describes what to do as data,
   * `applyTurnEffects` (turn-stream-effects.ts) executes it. `isReconnect`
   * gates the one effect whose meaning actually differs by which stream it
   * arrived on: a `user-message` echo means "show it optimistically" only
   * when reconnecting to a turn already in progress — for a turn this tab
   * itself started, `onMutate` already wrote that optimistic message
   * directly, and appending it again here would duplicate it.
   */
  const runStreamEffects = useCallback(
    (effects: readonly TurnStreamEffect[], options?: { isReconnect?: boolean }) => {
      applyTurnEffects(queryClient, sessionId, messagesKey, effects, options);
    },
    [messagesKey, queryClient, sessionId],
  );

  /**
   * Fold one turn-stream event into state, and run whatever effects that
   * produced.
   *
   * Reads and writes `stateRef.current` rather than `state`: events arrive
   * from an async read loop (`readPiStream`), several to a tick, and each
   * has to see the last one's result rather than whatever `state` this
   * render closed over.
   */
  const dispatchStream = useCallback(
    (event: PiStreamEvent, options?: { isReconnect?: boolean }) => {
      const { effects, state: next } = applyStreamEvent(
        stateRef.current,
        event,
      );
      stateRef.current = next;
      setState(next);
      runStreamEffects(effects, options);
    },
    [runStreamEffects],
  );

  /**
   * The reset every new turn needs, plus the one cache write
   * `resetForNewTurn` (a pure function with no `queryClient` of its own)
   * cannot make itself: the live tool-call cache other components read
   * through `sessionLiveToolCallsKey`.
   */
  const resetStreamState = useCallback(() => {
    stateRef.current = resetForNewTurn(stateRef.current);
    setState(stateRef.current);
    queryClient.setQueryData(sessionLiveToolCallsKey(sessionId), [] as SessionToolCall[]);
  }, [queryClient, sessionId]);

  const [isReconnecting, setIsReconnecting] = useState(false);

  /**
   * Attach to a turn that is already running on the server.
   *
   * Called on mount for a page loaded mid-turn, and again whenever the server
   * says a session is running while nothing is arriving here. A dropped stream
   * and a finished turn look identical from the client — the stream is the only
   * signal — so without this the page went quiet while the server carried on,
   * which is exactly what a capture run looked like for twenty minutes.
   */
  const reconnectToStream = useCallback(() => {
    reconnectAbortRef.current?.abort();

    const controller = new AbortController();
    reconnectAbortRef.current = controller;

    const reconnect = async () => {
      resetStreamState();
      setIsReconnecting(true);

      try {
        const response = await fetch(`/api/sessions/${sessionId}/stream`, {
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          // Stream not active — server restarted or turn already finished.
          // No latch needed to keep this from spinning: unlike the old status
          // poll, `serverIsRunning` is not a cache that goes on repeating a
          // stale reading on its own timer — it only ever changes again when a
          // fresh event (a real `session-status` push, or a new mount's
          // `initialIsRunning`) says so, so setting it false here does not
          // provoke another reattach on its own.
          dispatchStream({
            isRunning: false,
            turnStartedAt: null,
            type: "session-status",
          });

          // No invalidateQueries here: this branch's `return` still runs the
          // `finally` below, whose handOffToTranscript() already invalidates
          // messagesKey once. Invalidating here too doubled it — two
          // /messages GETs for one dead-stream reading.
          return;
        }

        await readPiStream(response.body.getReader(), (event) =>
          dispatchStream(event, { isReconnect: true }),
        );
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        // Non-fatal — settle and refetch below.
      } finally {
        setIsReconnecting(false);
        stateRef.current = {
          ...stateRef.current,
          activeTool: undefined,
          pendingFeatureSpec: false,
          pendingQuestion: null,
        };
        setState(stateRef.current);
        await handOffToTranscript();
      }
    };

    void reconnect();
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, dispatchStream, resetStreamState, handOffToTranscript]);

  useEffect(() => {
    if (!initialIsRunning) return;
    reconnectToStream();

    return () => {
      reconnectAbortRef.current?.abort();
      reconnectAbortRef.current = null;
    };
  }, [initialIsRunning, reconnectToStream]);

  /**
   * Whether this session has a record on disk at all, and this hook's initial
   * read of `isRunning` for a page that did not already know it (see
   * `serverIsRunning`'s own doc comment — that field is otherwise seeded from
   * `initialIsRunning` and kept current by the `session-status` push).
   *
   * Fetched once, not polled: `exists` does not change once a session is
   * created, and `isRunning` here is only a fallback for the gap between mount
   * and the first push — the mid-turn reconnect effect below covers that gap
   * on `initialIsRunning` already, and once a stream is open the push is the
   * source of truth.
   */
  const { data: sessionStatus } = useQuery({
    queryKey: sessionStatusKey(sessionId),
    queryFn: () => fetchSingleSessionStatus(sessionId),
  });

  /**
   * Undefined until the first fetch answers, and while it is undefined the page
   * must not claim anything: a `?new=1` page is legitimately promptable before
   * its session exists.
   */
  const sessionExists = sessionStatus?.exists;

  const mutation = useMutation<
    void,
    Error,
    PromptInput,
    { epoch: number; previousMessages: SessionMessage[] }
  >({
    mutationFn: async ({ create, editEntryId, leafId, model, text, tools }) => {
      const id = ++traceSeq;
      trace("mutationFn:start", { id, textLength: text.length });
      const response = await fetch(`/api/sessions/${sessionId}/prompt`, {
        body: JSON.stringify({ create, editEntryId, leafId, model, text, tools }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      trace("mutationFn:response", {
        id,
        ok: response.ok,
        status: response.status,
        hasBody: Boolean(response.body),
      });

      if (!response.ok || !response.body) {
        // The route's own message is the useful one — "Session not found." for
        // a session whose creation handoff was lost, which the generic text
        // turned into a mystery.
        throw new Error(await promptFailureMessage(response));
      }

      const piError = await readPiStream(response.body.getReader(), (event) =>
        dispatchStream(event),
      );

      if (piError) {
        trace("mutationFn:throwing", { id, message: piError.message });
        throw piError;
      }
      trace("mutationFn:resolved", { id });
    },
    onError: (mutationError, _variables, context) => {
      // A superseded call's error arrives after a newer one has already
      // started (see mutationEpochRef's docblock) — restoring its
      // `previousMessages` snapshot, or surfacing its error, would overwrite
      // whatever the newer, still-current call has since written. Nothing
      // to reconcile: the newer call owns the cache and the error banner now.
      if (!isCurrentMutation(context, mutationEpochRef.current)) {
        trace("onError:stale, ignored", {
          epoch: context?.epoch,
          current: mutationEpochRef.current,
        });
        return;
      }
      if (context?.previousMessages) {
        queryClient.setQueryData<SessionMessagesResult>(
          messagesKey,
          (prev) => ({
            contextWindow: prev?.contextWindow ?? null,
            messages: context.previousMessages,
            systemPromptChars: prev?.systemPromptChars,
            toolCalls: prev?.toolCalls ?? [],
          })
        );
      }
      stateRef.current = {
        ...stateRef.current,
        streamError:
          mutationError instanceof Error
            ? mutationError.message
            : "Pi could not process this prompt.",
      };
      setState(stateRef.current);
    },
    onMutate: async ({ leafId, text }) => {
      // Cancel any in-progress reconnect so it doesn't race with the new prompt.
      reconnectAbortRef.current?.abort();
      reconnectAbortRef.current = null;
      setIsReconnecting(false);

      // This call is now the one `onError`/`onSettled` should trust. A call
      // still in flight when this runs (e.g. one waiting on `ask_user`) keeps
      // its own, now-stale epoch closed over in the context it already
      // returned, so its callbacks can tell they've been superseded.
      const epoch = ++mutationEpochRef.current;

      inFlightRef.current += 1;
      trace(
        inFlightRef.current > 1
          ? "onMutate:start ⚠️ OVERLAPPING SUBMIT"
          : "onMutate:start",
        { inFlight: inFlightRef.current },
      );
      resetStreamState();
      await queryClient.cancelQueries({
        queryKey: messagesKey,
      });

      const previous =
        queryClient.getQueryData<SessionMessagesResult>(
          messagesKey
        );
      // Truncated to the fork point when this turn continues from one, so the
      // optimistic bubble lands right after it rather than after messages the
      // fork was supposed to have cut off — the client's own render already
      // shows that truncated view (client-session-component.tsx), and the
      // server is about to move the leaf there too. Disagreeing here would be
      // a visible jump: the bubble briefly after the wrong messages, then
      // snapping back once the real transcript refetches.
      const previousMessages = truncateAtMessage(
        previous?.messages ?? [],
        leafId,
      );
      queryClient.setQueryData<SessionMessagesResult>(
        messagesKey,
        {
          contextWindow: previous?.contextWindow ?? null,
          // Carried, not recomputed: these writes rebuild the cache entry, and
          // anything they leave out is dropped. The context-window bar reads
          // both, so losing them mid-turn empties the bar the prompt just
          // filled.
          systemPromptChars: previous?.systemPromptChars,
          // Preserve the tool-call markers already on the timeline; the refetch
          // after this turn brings in the ones this prompt produces.
          toolCalls: previous?.toolCalls ?? [],
          messages: [
            ...previousMessages,
            {
              createdAt: new Date().toISOString(),
              id: `optimistic-${crypto.randomUUID()}`,
              role: "user",
              text,
            },
          ],
        }
      );

      // The sidebar's poll cannot know yet; this turn has only just begun.
      setListRunning(true);

      trace("onMutate:end");
      return { epoch, previousMessages };
    },
    onSettled: async (_data, _error, _variables, context) => {
      trace("onSettled:start");

      // Guard for the same reason onError does: a call superseded by a newer
      // prompt (its stream kept open server-side by the residual-capture
      // `finally` chain in the prompt route) can settle after the newer call
      // already finished. Running the state resets and invalidations below
      // would then clobber the newer, still-current turn's result — which is
      // the bug this counter exists to close. `inFlightRef` still decrements
      // unconditionally: it is bookkeeping for the overlap trace, not state a
      // stale call is allowed to mutate.
      if (!isCurrentMutation(context, mutationEpochRef.current)) {
        trace("onSettled:stale, skipping cache effects", {
          epoch: context?.epoch,
          current: mutationEpochRef.current,
        });
        inFlightRef.current = Math.max(0, inFlightRef.current - 1);
        trace("onSettled:end", { inFlight: inFlightRef.current });
        return;
      }

      stateRef.current = {
        ...stateRef.current,
        activeTool: undefined,
        pendingFeatureSpec: false,
        pendingQuestion: null,
      };
      setState(stateRef.current);
      trace("onSettled:invalidate-begin");
      await handOffToTranscript();
      trace("onSettled:invalidate-done");

      // A turn can attach a project by writing a file, which for a session that
      // had none also changes the extension set it loads next time — so the
      // links and the tool list are both stale now. Not awaited: this block is
      // on the path that decides when the UI stops showing a running turn.
      for (const queryKey of projectChangeInvalidations(sessionId)) {
        void queryClient.invalidateQueries({ queryKey });
      }
      void queryClient.invalidateQueries({
        queryKey: sessionProjectsKey(sessionId),
      });

      // What the turn changed on disk is only knowable now it has stopped.
      // This read is what decides whether the review panel opens itself, and
      // it is one request rather than a `PiSessionEvent` variant: the client
      // already knows the turn ended, so an event would carry nothing it
      // lacks, and every variant added to session-events.ts is another shape
      // the router, the persist queue and the recovery path must agree on.
      void queryClient.invalidateQueries({
        queryKey: reviewQueryKey(sessionId),
      });

      // The editor's own buffer is keyed separately from the review state
      // above — `useFileContent` reads under `session-file-content`, not
      // under `review` — so without this the changed-files list and hunks
      // refresh but the open file's `value` prop never changes, and
      // CodeEditor's model-swap effect (code-editor.tsx) has nothing to fire
      // on: the buffer stays pinned to what was on disk before the turn.
      void queryClient.invalidateQueries({
        queryKey: fileContentQueryKeyPrefix(sessionId),
      });

      // The live accesses were attributed to `LIVE_TURN_ID` because nothing was
      // persisted yet. Now it is, so the refetched timeline carries the same
      // reads under their real turn — and keeping the live copies as well would
      // show every file the turn touched twice.
      queryClient.setQueryData(sessionLiveAccessesKey(sessionId), []);
      void queryClient.invalidateQueries({
        queryKey: ["file-access", sessionId],
      });

      setListRunning(false);

      // See reconnectIfStillRunning's own doc comment for why this is needed
      // at all: the POST stream this mutation just read from is a one-shot,
      // and does not survive a background workflow continuing past this turn.
      // Off the ref, not the state: see the field doc on `stateRef` for why
      // the state this closure captured is the wrong reading precisely when
      // it matters.
      reconnectIfStillRunning(stateRef.current.serverIsRunning, reconnectToStream);

      inFlightRef.current = Math.max(0, inFlightRef.current - 1);
      trace("onSettled:end", { inFlight: inFlightRef.current });
    },
  });

  useEffect(() => {
    trace("mount", { inst });
    return () => trace("unmount", { inst });
  }, [inst]);

  // TanStack's own transitions, straight off the MutationCache and independent
  // of React rendering. query-core dispatches "success" on the line right after
  // our onSettled resolves, so if that shows up here while the "status" trace
  // below stays pending, the mutation settled and the observer/render missed it.
  useEffect(() => {
    return queryClient.getMutationCache().subscribe((event) => {
      trace("cache", {
        inst,
        event: event.type,
        status: event.mutation?.state.status,
        isPaused: event.mutation?.state.isPaused,
      });
    });
  }, [queryClient, inst]);

  // The decisive line: if "onSettled:end" logs but this never reports
  // isPending=false, the mutation settled and React simply is not rendering it.
  // If this never logs after onSettled:start, the stall is inside onSettled.
  const liveTextLength = useMemo(
    () => state.liveRounds.reduce((sum, round) => sum + round.text.length, 0),
    [state.liveRounds],
  );

  useEffect(() => {
    trace("status", {
      inst,
      status: mutation.status,
      isPending: mutation.isPending,
      streamingTextLength: liveTextLength,
    });
  }, [inst, mutation.status, mutation.isPending, liveTextLength]);

  return {
    activeTool: state.activeTool,
    codeMap: state.codeMap,
    isReconnecting,
    serverIsRunning: state.serverIsRunning,
    serverTurnStartedAt: state.serverTurnStartedAt,
    /**
     * This turn's assistant round trips so far, in order — not one flattened
     * string. See live-rounds.ts for why: a turn that says something, calls a
     * tool, and says more is several round trips, and the caller needs them
     * kept apart to interleave live text with live tool calls the way
     * groupConversation already interleaves the persisted rows they become.
     */
    liveRounds: state.liveRounds,
    liveToolCalls: state.liveToolCalls,
    mutation,
    /**
     * The most recent `open_review` request this turn's agent made, if any.
     * See TurnStreamState's own doc on this field for why it carries a nonce.
     */
    openReviewRequest: state.openReviewRequest,
    pendingFeatureSpec: state.pendingFeatureSpec,
    pendingQuestion: state.pendingQuestion,
    /** The title the server derived from the first prompt, once it has. */
    serverTitle: state.serverTitle,
    /** Whether the server has a record for this session. See `sessionExists`. */
    sessionExists,
    /**
     * This session's recorded spans, in the order they opened — which is what
     * the Map already holds, since re-writing a key on close keeps its
     * position.
     */
    spans,
    streamError: state.streamError,
    wikiActive: state.wikiActive,
    workflowSnapshot: state.workflowSnapshot,
  };
};
