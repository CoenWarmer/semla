"use client";

/**
 * The conversation column: transcript, activity line, branch/fork notices,
 * and the prompt bar underneath it.
 *
 * Extracted out of `ClientSessionComponent` because it is rendered twice from
 * there — once alone, once as one side of the review panel's resizable split
 * — and inlining ~180 lines of JSX at each call site is exactly the kind of
 * large-file growth AGENTS.md asks to avoid.
 */

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import { MessageSquareIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import type { PromptEditorModel } from "./prompt-editor";
import { AskUserDialog } from "./ask-user-dialog";
import { CopyMessageButton } from "./message-copy";
import { EditableUserMessage } from "./message-edit";
import { ForkMessageButton } from "./message-fork";
import { GoalEditor } from "../session/goal-editor";
import { PromptEditor } from "./prompt-editor";
import { SessionActivityLine } from "@/components/conversation/session-activity-line";
import { WorkflowPhaseBar } from "@/components/conversation/workflow-phase-bar";
import { SessionStepsStrip } from "./session-steps-strip";
import type { ConversationItem } from "@/lib/session-steps";
import { isLiveRoundMessageId } from "@/lib/live-tool-calls";
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input";
import type { AskUserPayload } from "@/lib/pi/ask-user-bridge";
import type { WorkflowSnapshot } from "@/types/workflow";

export function SessionConversation({
  activeTool,
  conversation,
  contextWindowFraction,
  costPerTurn,
  defaultTools,
  elapsedLabel,
  errorMessage,
  estimatedTokens,
  forkedAt,
  goal,
  hasMessages,
  isActive,
  liveTextLength,
  onCancelFork,
  onCompactClick,
  onEditPrompt,
  onFork,
  onGoalSave,
  onSelectionChange,
  onStop,
  onSubmit,
  pendingQuestion,
  sessionId,
  sessionMissing,
  viewingLeafId,
  workflowSnapshot,
}: {
  activeTool: string | undefined;
  conversation: ConversationItem[];
  contextWindowFraction: number | null;
  costPerTurn: number | null;
  defaultTools: string[];
  elapsedLabel: string | null;
  errorMessage: string | undefined;
  estimatedTokens: number | null;
  forkedAt: string | null;
  goal: string | null;
  /** Whether the transcript has any messages, for the empty-state check. */
  hasMessages: boolean;
  isActive: boolean;
  liveTextLength: number;
  onCancelFork: () => void;
  onCompactClick: () => void;
  onEditPrompt: (entryId: string, text: string) => void;
  onFork: (entryId: string) => void;
  onGoalSave: (goal: string | null) => Promise<void>;
  onSelectionChange: (
    selection: { model: PromptEditorModel; tools: string[] } | null,
  ) => void;
  onStop: () => void;
  onSubmit: (
    message: PromptInputMessage,
    model: PromptEditorModel,
    tools: string[],
  ) => Promise<void>;
  pendingQuestion: AskUserPayload | null;
  sessionId: string;
  sessionMissing: boolean;
  viewingLeafId: string | null;
  /** Present for workflow runs; used to render the phase-progress bar. */
  workflowSnapshot: WorkflowSnapshot | null | undefined;
}) {
  const router = useRouter();

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-0">
      <Conversation className="min-h-0 w-full">
        <ConversationContent className="w-full">
          {!hasMessages ? (
            <ConversationEmptyState
              description="Send a message to start this session."
              icon={<MessageSquareIcon className="size-12" />}
              title="Start a conversation"
            />
          ) : (
            conversation.map((item) =>
              item.kind === "steps" ? (
                <SessionStepsStrip items={item.items} key={item.id} />
              ) : item.message.role === "user" ? (
                // Renders its own Message and bubble, so the edit button
                // can sit beside the bubble rather than inside it.
                <EditableUserMessage
                  disabled={isActive}
                  key={item.message.id}
                  message={item.message}
                  onFork={onFork}
                  onSubmit={onEditPrompt}
                />
              ) : (
                <Message
                  from={item.message.role}
                  id={item.message.id}
                  key={item.message.id}
                >
                  {/*
                      An assistant reply is left-aligned, so its gutter is on
                      the right — the mirror of the user row in
                      message-edit.tsx, which puts its buttons on the left.
                    */}
                  <div className="group/message flex items-start gap-2">
                    <MessageContent>
                      {/*
                        A live round's pseudo-message is still streaming, so
                        it animates the same way the old single streamingText
                        bubble did. isLiveRoundMessageId tells it apart from a
                        persisted message with the same shape — a real id is a
                        UUID and never matches this prefix.
                      */}
                      <MessageResponse
                        isAnimating={isLiveRoundMessageId(item.message.id)}
                        sessionId={sessionId}
                      >
                        {item.message.text}
                      </MessageResponse>
                    </MessageContent>
                    <div className="mt-1 flex shrink-0 items-center gap-1">
                      <ForkMessageButton
                        disabled={isActive}
                        onFork={() => onFork(item.message.id)}
                      />
                      <CopyMessageButton text={item.message.text} />
                    </div>
                  </div>
                </Message>
              ),
            )
          )}
          {/*
            `active` is the same value the prompt bar gets as `isRunning`
            below. Passing one signal to both is what stops the stop button
            and this line disagreeing about whether anything is happening.
          */}
          <WorkflowPhaseBar snapshot={workflowSnapshot} />
          <SessionActivityLine
            active={isActive}
            activeTool={activeTool}
            elapsedLabel={elapsedLabel}
            estimatedTokens={estimatedTokens}
            streaming={liveTextLength > 0}
          />
          {errorMessage && (
            <p className="text-destructive text-sm">{errorMessage}</p>
          )}
          {sessionMissing && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm">
              <p className="font-medium">This session was never created.</p>
              <p className="mt-1 text-muted-foreground">
                Its first prompt is what brings a session into being, and that
                prompt never reached the server — most likely the page was
                reloaded before it was sent. Prompts typed here cannot create
                it, so they will keep failing.
              </p>
              <Link
                className="mt-3 inline-block underline hover:no-underline"
                href="/sessions/new"
              >
                Start a new session
              </Link>
            </div>
          )}
        </ConversationContent>
        {/* {messages.length > 0 && (
        <ConversationDownload
          messages={
            messages.map((message) => ({
              id: message.id,
              parts: [{ text: message.text, type: "text" }],
              role: message.role,
            })) as UIMessage[]
          }
        />
      )} */}
        <ConversationScrollButton />
      </Conversation>
      {pendingQuestion && (
        <div className="shrink-0">
          <AskUserDialog
            payload={pendingQuestion}
            sessionId={sessionId}
            onDismiss={() => {}}
          />
        </div>
      )}
      {!forkedAt && viewingLeafId && (
        // A branch was opened from the graph (§4), not forked from a
        // message (§3) — there is no truncation to warn about here, since
        // this branch's own conversation is exactly what is rendered above.
        // What is worth saying is that it may not be the one every other
        // link to this session opens by default.
        <div className="flex shrink-0 items-center justify-between gap-2 border-border/40 border-t bg-muted/30 px-3 py-1.5 text-muted-foreground text-xs">
          <span>Viewing an earlier branch of this conversation.</span>
          <button
            className="shrink-0 underline hover:no-underline"
            onClick={() => router.push(`/sessions/${sessionId}`)}
            type="button"
          >
            Back to the live conversation
          </button>
        </div>
      )}
      {forkedAt && (
        // Nothing has diverged yet — see docs/plans/branching-sessions.md
        // §3. The conversation above is showing only up to the forked
        // message; whatever came after it on the live path still exists,
        // simply not reached from here until this is cancelled.
        <div className="flex shrink-0 items-center justify-between gap-2 border-border/40 border-t bg-muted/30 px-3 py-1.5 text-muted-foreground text-xs">
          <span>
            Continuing from an earlier message. The next prompt starts a new
            branch here.
          </span>
          <button
            className="shrink-0 underline hover:no-underline"
            onClick={onCancelFork}
            type="button"
          >
            Cancel
          </button>
        </div>
      )}
      <div className="shrink-0">
        <PromptEditor
          defaultTools={defaultTools}
          costPerTurn={costPerTurn}
          contextWindowFraction={contextWindowFraction}
          onCompactClick={onCompactClick}
          goalEditor={
            <GoalEditor
              /* Compact: it sits in the footer's tool row now, beside the
                 attachment and tool buttons, where the bordered block
                 variant was a full-width box among small controls. */
              variant="inline"
              autoFocus={!goal?.trim()}
              goal={goal}
              onSave={onGoalSave}
            />
          }
          /* Same signal as SessionActivityLine above. */
          isRunning={isActive}
          onSelectionChange={onSelectionChange}
          onStop={onStop}
          onSubmit={onSubmit}
          sessionId={sessionId}
        />
      </div>
    </div>
  );
}
