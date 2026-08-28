import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  sessionMessagesQueryKey,
  type SessionMessage,
  type SessionMessagesResult,
  type SessionToolCall,
} from "@/hooks/use-session-messages";
import { applyLiveToolEvent, type LiveToolEvent } from "@/lib/live-tool-calls";
import type { WorkflowSnapshot } from "@/types/workflow";
import type { AskUserPayload } from "@/lib/pi/ask-user-bridge";

export type PromptModel = {
  modelId: string;
  provider: string;
};

type PromptInput = {
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
  onWorkflowStarted: (event: Extract<PiStreamEvent, { type: "workflow-started" }>) => void;
  onTitleUpdated: () => void;
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
      } else if (piEvent.type === "workflow-started") {
        handlers.onWorkflowStarted(piEvent);
      } else if (piEvent.type === "title-updated") {
        handlers.onTitleUpdated();
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
  const router = useRouter();
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
  const [pendingQuestion, setPendingQuestion] = useState<AskUserPayload | null>(null);
  const [isReconnecting, setIsReconnecting] = useState(false);
  // Latches true the first time wiki_init or wiki_capture_source is seen; never
  // resets to false for the lifetime of the hook (i.e. the session page).
  const [wikiActive, setWikiActive] = useState(false);
  const wikiActiveRef = useRef(false);
  // A ref, not state. This is written from inside the SSE reader loop and read
  // by onSettled a couple of milliseconds later, with no render in between — so
  // as state, onSettled always closed over the stale `false` and the refresh
  // below never fired. Nothing renders from it, so a ref is the right tool.
  const titleUpdatedRef = useRef(false);
  const reconnectAbortRef = useRef<AbortController | null>(null);

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
      onTitleUpdated: () => {
        titleUpdatedRef.current = true;
      },
      onError: (message) => setStreamError(message),
      onWikiTool: (toolName) => {
        if (
          !wikiActiveRef.current &&
          (toolName === "wiki_bootstrap" ||
            toolName === "wiki_init" ||
            toolName === "wiki_capture_source")
        ) {
          wikiActiveRef.current = true;
          setWikiActive(true);
        }
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Reconnect to an in-progress stream when the page is loaded mid-turn.
  useEffect(() => {
    if (!initialIsRunning) return;

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
        setStreamingText("");
        setActiveTool(undefined);
        setPendingQuestion(null);
        await queryClient.invalidateQueries({
          queryKey: sessionMessagesQueryKey(sessionId),
        });
        if (titleUpdatedRef.current) {
          titleUpdatedRef.current = false;
          setTimeout(() => router.refresh(), 0);
        }
      }
    };

    void reconnect();

    return () => {
      controller.abort();
      reconnectAbortRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]); // only on mount — initialIsRunning is the mount-time value

  const mutation = useMutation<
    void,
    Error,
    PromptInput,
    { previousMessages: SessionMessage[] }
  >({
    mutationFn: async ({ model, text, tools }) => {
      const id = ++traceSeq;
      trace("mutationFn:start", { id, textLength: text.length });
      const response = await fetch(`/api/sessions/${sessionId}/prompt`, {
        body: JSON.stringify({ model, text, tools }),
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
      titleUpdatedRef.current = false;
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

      trace("onMutate:end");
      return { previousMessages };
    },
    onSettled: async () => {
      trace("onSettled:start", { titleUpdated: titleUpdatedRef.current });
      setStreamingText("");
      setActiveTool(undefined);
      setPendingQuestion(null);
      trace("onSettled:invalidate-begin");
      await queryClient.invalidateQueries({
        queryKey: sessionMessagesQueryKey(sessionId),
      });
      trace("onSettled:invalidate-done");
      inFlightRef.current = Math.max(0, inFlightRef.current - 1);
      trace("onSettled:end", { inFlight: inFlightRef.current });

      // The server only sends title-updated on a session's first prompt, so
      // this picks up the generated title for the topbar and the sidebar list.
      //
      // Deferred until after the stream has fully closed — calling it mid-stream
      // can disrupt the SSE reader loop — and past this callback, so a route
      // re-render can never sit between onSettled resolving and query-core
      // marking the mutation settled.
      if (titleUpdatedRef.current) {
        titleUpdatedRef.current = false;
        setTimeout(() => {
          trace("router-refresh");
          router.refresh();
        }, 0);
      }
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

  return {
    activeTool,
    isReconnecting,
    liveToolCalls,
    mutation,
    pendingQuestion,
    streamError,
    streamingText,
    wikiActive,
    workflowSnapshot,
  };
};
