import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

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

export const usePromptMutation = (sessionId: string) => {
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
  // Latches true the first time wiki_init or wiki_capture_source is seen; never
  // resets to false for the lifetime of the hook (i.e. the session page).
  const [wikiActive, setWikiActive] = useState(false);
  const wikiActiveRef = useRef(false);
  // A ref, not state. This is written from inside the SSE reader loop and read
  // by onSettled a couple of milliseconds later, with no render in between — so
  // as state, onSettled always closed over the stale `false` and the refresh
  // below never fired. Nothing renders from it, so a ref is the right tool.
  const titleUpdatedRef = useRef(false);

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

      const reader = response.body.getReader();
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

          if (!data) {
            continue;
          }

          let piEvent: PiStreamEvent;
          try {
            piEvent = JSON.parse(data) as PiStreamEvent;
          } catch (parseError) {
            console.error("Malformed SSE event from Pi stream:", data, parseError);
            continue;
          }

          if (piEvent.type === "assistant-delta") {
            setStreamingText((current) => current + piEvent.delta);
          } else if (piEvent.type === "tool-start") {
            setActiveTool(piEvent.toolName);
            setLiveToolCalls((current) => applyLiveToolEvent(current, piEvent));
            if (
              !wikiActiveRef.current &&
              (piEvent.toolName === "wiki_bootstrap" ||
                piEvent.toolName === "wiki_init" ||
                piEvent.toolName === "wiki_capture_source")
            ) {
              wikiActiveRef.current = true;
              setWikiActive(true);
            }
          } else if (piEvent.type === "tool-end") {
            setActiveTool(undefined);
            setLiveToolCalls((current) => applyLiveToolEvent(current, piEvent));
            if (piEvent.toolName === "ask_user") {
              setPendingQuestion(null);
            }
          } else if (piEvent.type === "ask-user-question") {
            setPendingQuestion(piEvent.payload);
          } else if (piEvent.type === "workflow-snapshot") {
            setWorkflowSnapshot(piEvent.snapshot);
          } else if (piEvent.type === "workflow-started") {
            setWorkflowSnapshot({
              agentCount: 0,
              agents: [],
              doneCount: 0,
              errorCount: 0,
              name: "Background workflow",
              phases: [],
              runId: piEvent.runId,
              runningCount: 0,
              startedAt: piEvent.startedAt,
            });
          } else if (piEvent.type === "title-updated") {
            trace("event:title-updated", { id });
            titleUpdatedRef.current = true;
          } else if (piEvent.type === "complete") {
            trace("event:complete", { id });
          } else if (piEvent.type === "error") {
            trace("event:error", { id, message: piEvent.message });
            piError = new Error(piEvent.message);
            setStreamError(piEvent.message);
          }
        }

        if (done) {
          trace("mutationFn:stream-done", { id });
          break;
        }
      }

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
    liveToolCalls,
    mutation,
    pendingQuestion,
    streamError,
    streamingText,
    wikiActive,
    workflowSnapshot,
  };
};
