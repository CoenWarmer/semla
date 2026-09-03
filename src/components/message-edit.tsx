"use client";

/**
 * Editing a prompt, and seeing what it said before.
 *
 * Editing here is not a correction in place — the session is append-only, and
 * the agent has already answered the old wording. Saving starts a new branch
 * from the same point and re-runs, so the reply below is replaced by a new one.
 * The button says "Save & run" rather than "Save" for that reason: nothing about
 * this is a quiet text change.
 *
 * The earlier wordings are kept and shown. They are still in the session file
 * either way, so hiding them would only mean the record existed somewhere the
 * person who made it could not see it.
 *
 * Lives outside client-session-component.tsx, which is long enough already; that
 * file supplies a handler and nothing else.
 */

import { CheckIcon, PencilIcon } from "lucide-react";
import { useState } from "react";

import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import type { SessionMessage } from "@/hooks/use-session-messages";
import { CopyMessageButton } from "@/components/message-copy";
import { cn } from "@/lib/utils";

interface EditableUserMessageProps {
  message: SessionMessage;
  /** A turn is in flight; branching the leaf under it would interleave paths. */
  disabled?: boolean;
  onSubmit: (entryId: string, text: string) => void;
}

export function EditableUserMessage({
  disabled = false,
  message,
  onSubmit,
}: EditableUserMessageProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.text);
  const [showVersions, setShowVersions] = useState(false);

  const start = () => {
    setDraft(message.text);
    setEditing(true);
  };

  const cancel = () => {
    setDraft(message.text);
    setEditing(false);
  };

  const save = () => {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === message.text.trim()) {
      cancel();
      return;
    }
    setEditing(false);
    onSubmit(message.id, trimmed);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      save();
    }
  };

  /**
   * The field, sized by a copy of its own text.
   *
   * The bubble is `w-fit`, so its width comes from its child's *intrinsic*
   * width — and a textarea's is its `cols`, which defaults to 20 regardless of
   * what is in it. So a long prompt collapsed to twenty characters the moment
   * it went into edit mode.
   *
   * Both elements occupy one grid cell: the invisible copy wraps exactly as
   * the message does and gives the cell its size, and the field fills it. That
   * makes editing the same shape as reading, and it grows as you type without
   * measuring anything — which is why the effect that used to set
   * `scrollHeight` on every keystroke is gone.
   *
   * `cols={1}` and `rows={1}` so the field's own intrinsic size contributes
   * nothing. Both defaults are floors in the shared cell: `cols` is 20
   * characters, and `rows` is *two lines* — which is where the bubble's extra
   * 40px of height came from, whatever the message actually said.
   */
  const editor = (
    <div className="grid">
      <div
        aria-hidden
        className="invisible whitespace-pre-wrap text-sm [grid-area:1/1]"
      >
        {/* A trailing newline collapses, leaving the last line unaccounted
            for and the field one row short. */}
        {draft.endsWith("\n") ? `${draft} ` : draft}
      </div>
      <textarea
        autoFocus
        className="w-full resize-none overflow-hidden bg-transparent text-sm outline-none [grid-area:1/1]"
        cols={1}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
        rows={1}
        value={draft}
      />
    </div>
  );

  const versions = message.versions ?? [];

  return (
    // The message owns its own bubble, which is what lets the edit button sit
    // beside it: the button used to be inside `MessageContent`, and nothing
    // rendered from in there can escape it.
    <Message from="user" id={message.id}>
      <div className="group/message flex items-center justify-end gap-2">
        {/*
          Left of the bubble, because a user message is right-aligned — this
          is the gutter between it and the conversation. Copy first, so edit
          stays nearest the bubble it edits.
        */}
        {!editing && <CopyMessageButton text={message.text} />}
        <button
          className={cn(
            "shrink-0 transition-opacity hover:text-foreground focus-visible:opacity-100 disabled:cursor-not-allowed",
            editing
              ? // Visible, and visible even when disabled: it is the only way
                // to commit an edit, and hiding it would strand someone in a
                // textarea with nothing to press.
                "text-foreground opacity-100 disabled:opacity-40"
              : "text-muted-foreground opacity-0 group-hover/message:opacity-100 disabled:opacity-0",
          )}
          disabled={disabled}
          onClick={editing ? save : start}
          title={
            disabled
              ? "Wait for the current turn to finish"
              : editing
                ? "Save and run this prompt"
                : "Edit this prompt and run it again"
          }
          type="button"
        >
          {editing ? (
            <CheckIcon className="size-3.5" />
          ) : (
            <PencilIcon className="size-3.5" />
          )}
          <span className="sr-only">
            {editing ? "Save and run this prompt" : "Edit this prompt"}
          </span>
        </button>

        {/*
          `ml-auto` is cancelled at the same variant it is set on. Left alone
          it pushes the bubble to the far end of this row and strands the
          button against the opposite edge; the row's `justify-end` already
          does the aligning.
        */}
        <MessageContent className="group-[.is-user]:ml-0">
          {editing ? editor : <MessageResponse>{message.text}</MessageResponse>}

          {/* Stays in the bubble: it is about this message, not an action. */}
          {!editing && versions.length > 0 && (
            <button
              className="self-start text-muted-foreground text-xs hover:text-foreground transition-colors"
              onClick={() => setShowVersions((open) => !open)}
              type="button"
            >
              edited · {versions.length + 1} versions {showVersions ? "▴" : "▾"}
            </button>
          )}
        </MessageContent>
      </div>

      {showVersions && versions.length > 0 && (
        <div className="mt-1 flex flex-col gap-2 rounded border border-border/40 bg-muted/30 p-2">
          {versions.map((version, index) => (
            <div
              className="flex flex-col gap-0.5"
              key={`${index}-${version.slice(0, 24)}`}
            >
              <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
                v{index + 1}
              </span>
              <span className="whitespace-pre-wrap text-muted-foreground text-xs">
                {version}
              </span>
            </div>
          ))}
          <div className="flex flex-col gap-0.5">
            <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
              v{versions.length + 1} · current
            </span>
            <span className="whitespace-pre-wrap text-xs">{message.text}</span>
          </div>
        </div>
      )}
    </Message>
  );
}
