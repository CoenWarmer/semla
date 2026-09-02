import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  sessionMessagesQueryKey,
  type SessionMessage,
  type SessionMessagesResult,
  type SessionToolCall,
} from "@/hooks/use-session-messages";
import { handOffStreamedAnswer } from "@/lib/streamed-answer-handoff";
import {
  projectChangeInvalidations,
  sessionProjectsKey,
} from "@/hooks/use-session-projects";
import { applyLiveToolEvent, type LiveToolEvent } from "@/lib/live-tool-calls";
import {
  clearsDeadStreamLatch,
  shouldReconnect,
} from "@/lib/session-reconnect";
import {
  fetchSingleSessionStatus,
  SESSION_STATUS_KEY,
  sessionStatusKey,
  withSessionRunning,
  type SessionStatus,
  type SingleSessionStatus,
} from "@/lib/session-status";
import { startsWikiActivity } from "@/lib/wiki-activity";
import type { WorkflowSnapshot } from "@/types/workflow";
import type { CodeMap } from "@/lib/code-map/types";
import type { AskUserPayload } from "@/lib/pi/ask-user-bridge";

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
  model: PromptModel;
  text: string;
  tools: string[];
};

type PiStreamEvent =
  | { text: string; type: "user-message" }
  | { delta: string; type: "assistant-delta" }
  | { message: string; type: "error" }
  | LiveToolEvent
  | { runId: string; startedAt: string; type: "workflow-started" }
  | { snapshot: WorkflowSnapshot; type: "workflow-snapshot" }
  | { map: CodeMap; type: "code-map" }
  | { payload: AskUserPayload; type: "ask-user-question" }
  | { title: string; type: "title-updated" }
  | { type: "complete" };

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

type StreamHandlers = {
  onUserMessage?: (text: string) => void;
  onDelta: (delta: string) => void;
  onToolStart: (event: Extract<PiStreamEvent, { type: "tool-start" }>) => void;
  onToolEnd: (event: Extract<PiStreamEvent, { type: "tool-end" }>) => void;
  onAskUser: (payload: AskUserPayload) => void;
  onWorkflowSnapshot: (snapshot: WorkflowSnapshot) => void;
  onCodeMap: (map: CodeMap) => void;
  onWorkflowStarted: (event: Extract<PiStreamEvent, { type: "workflow-started" }>) => void;
  onTitleUpdated: (title: string) => void;
  onError: (message: string) => void;
  onWikiTool: (toolName: string) => void;
};

const readPiStream = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  handlers: StreamHandlers,
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

      if (piEvent.type === "user-message") {
        handlers.onUserMessage?.(piEvent.text);
      } else if (piEvent.type === "assistant-delta") {
        handlers.onDelta(piEvent.delta);
      } else if (piEvent.type === "tool-start") {
        handlers.onToolStart(piEvent);
        handlers.onWikiTool(piEvent.toolName);
      } else if (piEvent.type === "tool-end") {
        handlers.onToolEnd(piEvent);
      } else if (piEvent.type === "ask-user-question") {
        handlers.onAskUser(piEvent.payload);
      } else if (piEvent.type === "workflow-snapshot") {
        handlers.onWorkflowSnapshot(piEvent.snapshot);
      } else if (piEvent.type === "code-map") {
        handlers.onCodeMap(piEvent.map);
      } else if (piEvent.type === "workflow-started") {
        handlers.onWorkflowStarted(piEvent);
      } else if (piEvent.type === "title-updated") {
        handlers.onTitleUpdated(piEvent.title);
      } else if (piEvent.type === "complete") {
        // nothing — loop will end on done
      } else if (piEvent.type === "error") {
        piError = new Error(piEvent.message);
        handlers.onError(piEvent.message);
      }
    }

    if (done) break;
  }

  return piError;
};

export const usePromptMutation = (sessionId: string, initialIsRunning?: boolean) => {
  const queryClient = useQueryClient();

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
  // Identifies this hook instance, so a trace line can be attributed to the
  // component that is actually rendering the spinner.
  const [inst] = useState(() => Math.random().toString(36).slice(2, 7));
  const [streamingText, setStreamingText] = useState("");
  const [activeTool, setActiveTool] = useState<string>();
  // Tool calls seen on the stream, so the timeline can show them as they happen
  // rather than only after the turn's entries are persisted. Kept until the
  // next prompt: the merge with the persisted rows is keyed by tool call id, so
  // a live row is replaced rather than duplicated once the refetch lands.
  const [liveToolCalls, setLiveToolCalls] = useState<SessionToolCall[]>([]);
  const [streamError, setStreamError] = useState<string>();
  const [workflowSnapshot, setWorkflowSnapshot] = useState<WorkflowSnapshot>();
  // Latest map this session drew. Kept per session rather than per turn: the
  // user asks about one thing, then talks about it for several turns.
  const [codeMap, setCodeMap] = useState<CodeMap>();
  const [pendingQuestion, setPendingQuestion] = useState<AskUserPayload | null>(null);
  const [isReconnecting, setIsReconnecting] = useState(false);
  // Latches true the first time wiki_init or wiki_capture_source is seen; never
  // resets to false for the lifetime of the hook (i.e. the session page).
  const [wikiActive, setWikiActive] = useState(false);
  const wikiActiveRef = useRef(false);
  /**
   * The title the server derived from the first prompt.
   *
   * The server sends this once per session, on its first turn. It used to set a
   * ref that triggered `router.refresh()` after the turn — a full root-layout
   * re-render, measured at 3,974ms and 78KB of RSC payload carrying every
   * session in the sidebar and its token usage, to propagate one string.
   *
   * The string is in the event, so the page can simply render it. The sidebar
   * needs nothing either: a session the server render did not have is added
   * from the status poll, with the title the poll reports — which is the
   * new-session case, and the only case this event fires in.
   */
  const [serverTitle, setServerTitle] = useState<string | null>(null);

  /** See streamed-answer-handoff.ts for why the order here matters. */
  const handOffToTranscript = useCallback(
    () =>
      handOffStreamedAnswer({
        clearStreamed: () => setStreamingText(""),
        loadTranscript: () =>
          queryClient.invalidateQueries({
            queryKey: sessionMessagesQueryKey(sessionId),
          }),
      }),
    [queryClient, sessionId],
  );
  const reconnectAbortRef = useRef<AbortController | null>(null);
  // Set when a reattach is told this session has no stream. The status poll is a
  // cache and goes on saying "running" for a few seconds after a turn ends, so
  // without this memory the recovery effect refires on every settle and spins.
  // A ref, not state: it must be readable by the effect on the same tick it is
  // written, and nothing renders from it.
  const streamKnownDeadRef = useRef(false);
  // The previous poll reading, so a turn starting can be told from one that was
  // already running when this page mounted.
  const wasServerRunningRef = useRef(false);

  // Stable handlers object — state setters are guaranteed stable by React,
  // so this memo never needs to re-run. A factory function (the previous shape)
  // created new closure objects on every call, which confused the React Compiler.
  const handlers = useMemo(
    (): StreamHandlers => ({
      onDelta: (delta) => setStreamingText((t) => t + delta),
      onToolStart: (event) => {
        setActiveTool(event.toolName);
        setLiveToolCalls((c) => applyLiveToolEvent(c, event));
      },
      onToolEnd: (event) => {
        setActiveTool(undefined);
        setLiveToolCalls((c) => applyLiveToolEvent(c, event));
        if (event.toolName === "ask_user") setPendingQuestion(null);
      },
      onAskUser: (payload) => setPendingQuestion(payload),
      onWorkflowSnapshot: (snapshot) => setWorkflowSnapshot(snapshot),
      onCodeMap: (map) => setCodeMap(map),
      onWorkflowStarted: (event) =>
        setWorkflowSnapshot({
          agentCount: 0,
          agents: [],
          doneCount: 0,
          errorCount: 0,
          name: "Background workflow",
          phases: [],
          runId: event.runId,
          runningCount: 0,
          startedAt: event.startedAt,
        }),
      onTitleUpdated: (title) => {
        setServerTitle(title);
        // So the sidebar shows it now rather than on its next poll.
        void queryClient.invalidateQueries({ queryKey: SESSION_STATUS_KEY });
      },
      onError: (message) => setStreamError(message),
      onWikiTool: (toolName) => {
        if (!wikiActiveRef.current && startsWikiActivity(toolName)) {
          wikiActiveRef.current = true;
          setWikiActive(true);
        }
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

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
      setStreamingText("");
      setActiveTool(undefined);
      setLiveToolCalls([]);
      setWorkflowSnapshot(undefined);
      setIsReconnecting(true);

      try {
        const response = await fetch(`/api/sessions/${sessionId}/stream`, {
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          // Stream not active — server restarted or turn already finished.
          // Remember it: the status poll is a cache and will keep reporting this
          // turn as running for a few seconds yet, and asking again every time
          // the effect settles is what turned one stale reading into eight
          // requests.
          streamKnownDeadRef.current = true;

          // Correct the cached reading too, so the rest of the UI stops showing
          // a turn that has demonstrably ended rather than waiting for the next
          // poll. The route clears the stored flag; this is the local view of it.
          queryClient.setQueryData<SingleSessionStatus>(
            sessionStatusKey(sessionId),
            (prev) => (prev ? { ...prev, isRunning: false } : prev),
          );
          setListRunning(false);

          await queryClient.invalidateQueries({
            queryKey: sessionMessagesQueryKey(sessionId),
          });
          return;
        }

        await readPiStream(response.body.getReader(), {
          ...handlers,
          onUserMessage: (text) => {
            queryClient.setQueryData<SessionMessagesResult>(
              sessionMessagesQueryKey(sessionId),
              (prev) => ({
                contextWindow: prev?.contextWindow ?? null,
                systemPromptChars: prev?.systemPromptChars,
                toolCalls: prev?.toolCalls ?? [],
                messages: [
                  ...(prev?.messages ?? []),
                  {
                    createdAt: new Date().toISOString(),
                    id: `optimistic-reconnect-${crypto.randomUUID()}`,
                    role: "user" as const,
                    text,
                  },
                ],
              }),
            );
          },
        });
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        // Non-fatal — settle and refetch below.
      } finally {
        setIsReconnecting(false);
        setActiveTool(undefined);
        setPendingQuestion(null);
        await handOffToTranscript();
      }
    };

    void reconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    if (!initialIsRunning) return;
    reconnectToStream();

    return () => {
      reconnectAbortRef.current?.abort();
      reconnectAbortRef.current = null;
    };
  }, [initialIsRunning, reconnectToStream]);

  /**
   * What the server says about this session, which is the only way to notice a
   * stream that has gone away.
   *
   * The client cannot tell a dropped stream from a finished turn — both are
   * simply an absence of events — so this is the second opinion. It reads the
   * running flag from disk and is reconciled against the process actually
   * working on the session, so it does not report a turn a restart ended.
   */
  const { data: sessionStatus } = useQuery({
    queryKey: sessionStatusKey(sessionId),
    queryFn: () => fetchSingleSessionStatus(sessionId),
    refetchInterval: 5_000,
  });

  const serverIsRunning = sessionStatus?.isRunning ?? false;


  const mutation = useMutation<
    void,
    Error,
    PromptInput,
    { previousMessages: SessionMessage[] }
  >({
    mutationFn: async ({ create, editEntryId, model, text, tools }) => {
      const id = ++traceSeq;
      trace("mutationFn:start", { id, textLength: text.length });
      const response = await fetch(`/api/sessions/${sessionId}/prompt`, {
        body: JSON.stringify({ create, editEntryId, model, text, tools }),
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
        throw new Error("Pi could not start this prompt.");
      }

      const piError = await readPiStream(response.body.getReader(), handlers);

      if (piError) {
        trace("mutationFn:throwing", { id, message: piError.message });
        throw piError;
      }
      trace("mutationFn:resolved", { id });
    },
    onError: (mutationError, _variables, context) => {
      if (context?.previousMessages) {
        queryClient.setQueryData<SessionMessagesResult>(
          sessionMessagesQueryKey(sessionId),
          (prev) => ({
            contextWindow: prev?.contextWindow ?? null,
            messages: context.previousMessages,
            systemPromptChars: prev?.systemPromptChars,
            toolCalls: prev?.toolCalls ?? [],
          })
        );
      }
      setStreamError(
        mutationError instanceof Error
          ? mutationError.message
          : "Pi could not process this prompt."
      );
    },
    onMutate: async ({ text }) => {
      // Cancel any in-progress reconnect so it doesn't race with the new prompt.
      reconnectAbortRef.current?.abort();
      reconnectAbortRef.current = null;
      setIsReconnecting(false);

      inFlightRef.current += 1;
      trace(
        inFlightRef.current > 1
          ? "onMutate:start ⚠️ OVERLAPPING SUBMIT"
          : "onMutate:start",
        { inFlight: inFlightRef.current },
      );
      setStreamError(undefined);
      setStreamingText("");
      setActiveTool(undefined);
      setLiveToolCalls([]);
      setWorkflowSnapshot(undefined);
      setPendingQuestion(null);
      await queryClient.cancelQueries({
        queryKey: sessionMessagesQueryKey(sessionId),
      });

      const previous =
        queryClient.getQueryData<SessionMessagesResult>(
          sessionMessagesQueryKey(sessionId)
        );
      const previousMessages = previous?.messages ?? [];
      queryClient.setQueryData<SessionMessagesResult>(
        sessionMessagesQueryKey(sessionId),
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
      return { previousMessages };
    },
    onSettled: async () => {
      trace("onSettled:start");
      setActiveTool(undefined);
      setPendingQuestion(null);
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

      setListRunning(false);
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
  useEffect(() => {
    trace("status", {
      inst,
      status: mutation.status,
      isPending: mutation.isPending,
      streamingTextLength: streamingText.length,
    });
  }, [inst, mutation.status, mutation.isPending, streamingText.length]);

  useEffect(() => {
    // A turn the server has only just started re-arms the latch: the stream this
    // page was told was gone is not the stream a new turn opens.
    if (clearsDeadStreamLatch(wasServerRunningRef.current, serverIsRunning)) {
      streamKnownDeadRef.current = false;
    }
    wasServerRunningRef.current = serverIsRunning;

    if (
      !shouldReconnect({
        serverIsRunning,
        isPending: mutation.isPending,
        isReconnecting,
        streamKnownDead: streamKnownDeadRef.current,
      })
    ) {
      return;
    }

    trace("stream-recovery:reattach");
    reconnectToStream();
  }, [serverIsRunning, isReconnecting, mutation.isPending, reconnectToStream]);

  return {
    activeTool,
    codeMap,
    isReconnecting,
    serverIsRunning,
    liveToolCalls,
    mutation,
    pendingQuestion,
    /** The title the server derived from the first prompt, once it has. */
    serverTitle,
    streamError,
    streamingText,
    wikiActive,
    workflowSnapshot,
  };
};
