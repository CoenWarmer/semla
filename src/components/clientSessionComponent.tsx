"use client";

import {
  Conversation,
  ConversationContent,
  ConversationDownload,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input";
import { usePromptMutation } from "@/hooks/use-prompt-mutation";
import { useSessionMessages } from "@/hooks/use-session-messages";
import { PromptEditor, type PromptEditorModel } from "./prompt-editor";
import type { UIMessage } from "ai";
import { MessageSquareIcon } from "lucide-react";
import { useCallback } from "react";

export function ClientSessionComponent({ sessionId }: { sessionId: string }) {
  const messagesQuery = useSessionMessages(sessionId);
  const {
    activeTool,
    mutation: promptMutation,
    streamError,
    streamingText,
  } = usePromptMutation(sessionId);
  const messages = messagesQuery.data ?? [];
  const errorMessage =
    streamError ??
    (messagesQuery.error instanceof Error
      ? messagesQuery.error.message
      : undefined);

  const handleSubmit = useCallback(
    async (message: PromptInputMessage, model: PromptEditorModel) => {
      if (!message.text.trim()) {
        return;
      }

      await promptMutation.mutateAsync({ model, text: message.text });
    },
    [promptMutation],
  );

  return (
    <div className="flex size-full min-h-0 flex-col p-20">
      <Conversation>
        <ConversationContent>
          {messages.length === 0 ? (
            <ConversationEmptyState
              description="Send a message to start this session."
              icon={<MessageSquareIcon className="size-12" />}
              title="Start a conversation"
            />
          ) : (
            messages.map((message) => (
              <Message from={message.role} key={message.id}>
                <MessageContent>
                  <MessageResponse>{message.text}</MessageResponse>
                </MessageContent>
              </Message>
            ))
          )}
          {streamingText && (
            <Message from="assistant">
              <MessageContent>
                <MessageResponse isAnimating>{streamingText}</MessageResponse>
              </MessageContent>
            </Message>
          )}
          {activeTool && (
            <p className="text-muted-foreground text-sm">
              Running {activeTool}…
            </p>
          )}
          {errorMessage && (
            <p className="text-destructive text-sm">{errorMessage}</p>
          )}
        </ConversationContent>
        {messages.length > 0 && (
          <ConversationDownload
            messages={
              messages.map((message) => ({
                id: message.id,
                parts: [{ text: message.text, type: "text" }],
                role: message.role,
              })) as UIMessage[]
            }
          />
        )}
        <ConversationScrollButton />
      </Conversation>
      <PromptEditor onSubmit={handleSubmit} />
    </div>
  );
}
