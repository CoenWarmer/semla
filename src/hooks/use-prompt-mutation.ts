import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  sessionMessagesQueryKey,
  type SessionMessage,
  type SessionMessagesResult,
} from "@/hooks/use-session-messages";
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
  | { toolName: string; type: "tool-end" | "tool-start" }
  | { runId: string; type: "workflow-started" }
  | { snapshot: WorkflowSnapshot; type: "workflow-snapshot" }
  | { payload: AskUserPayload; type: "ask-user-question" }
  | { title: string; type: "title-updated" }
  | { type: "complete" };

export const usePromptMutation = (sessionId: string) => {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [streamingText, setStreamingText] = useState("");
  const [activeTool, setActiveTool] = useState<string>();
  const [streamError, setStreamError] = useState<string>();
  const [workflowSnapshot, setWorkflowSnapshot] = useState<WorkflowSnapshot>();
  const [pendingQuestion, setPendingQuestion] = useState<AskUserPayload | null>(null);

  const mutation = useMutation<
    void,
    Error,
    PromptInput,
    { previousMessages: SessionMessage[] }
  >({
    mutationFn: async ({ model, text, tools }) => {
      const response = await fetch(`/api/sessions/${sessionId}/prompt`, {
        body: JSON.stringify({ model, text, tools }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
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
          } else if (piEvent.type === "tool-end") {
            setActiveTool(undefined);
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
            });
          } else if (piEvent.type === "title-updated") {
            router.refresh();
          } else if (piEvent.type === "error") {
            piError = new Error(piEvent.message);
            setStreamError(piEvent.message);
          }
        }

        if (done) {
          break;
        }
      }

      if (piError) {
        throw piError;
      }
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
      setStreamError(undefined);
      setStreamingText("");
      setActiveTool(undefined);
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

      return { previousMessages };
    },
    onSettled: async () => {
      setStreamingText("");
      setActiveTool(undefined);
      setPendingQuestion(null);
      await queryClient.invalidateQueries({
        queryKey: sessionMessagesQueryKey(sessionId),
      });
    },
  });

  return { activeTool, mutation, pendingQuestion, streamError, streamingText, workflowSnapshot };
};
