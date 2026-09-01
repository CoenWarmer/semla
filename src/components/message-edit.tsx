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

import { CheckIcon, PencilIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { MessageResponse } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import type { SessionMessage } from "@/hooks/use-session-messages";

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
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Grow to fit rather than scrolling a three-line box: a prompt being corrected
  // is usually being read in full first.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!editing || !textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [draft, editing]);

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

  if (editing) {
    return (
      <div className="flex w-full flex-col gap-2">
        <textarea
          autoFocus
          className="w-full resize-none bg-transparent text-sm outline-none"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          ref={textareaRef}
          value={draft}
        />
        <div className="flex items-center gap-2">
          <Button onClick={save} size="sm" variant="secondary">
            <CheckIcon />
            Save &amp; run
          </Button>
          <Button onClick={cancel} size="sm" variant="ghost">
            <XIcon />
            Cancel
          </Button>
          <span className="text-muted-foreground text-xs">
            Replaces the reply below · ⌘↵ to run · Esc to cancel
          </span>
        </div>
      </div>
    );
  }

  const versions = message.versions ?? [];

  return (
    <div className="group/message flex w-full flex-col gap-1">
      <MessageResponse>{message.text}</MessageResponse>

      <div className="flex items-center gap-2">
        <button
          className="text-muted-foreground text-xs opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/message:opacity-100 disabled:cursor-not-allowed disabled:opacity-0"
          disabled={disabled}
          onClick={start}
          title={
            disabled
              ? "Wait for the current turn to finish"
              : "Edit this prompt and run it again"
          }
          type="button"
        >
          <PencilIcon className="mr-1 inline size-3" />
          Edit
        </button>

        {versions.length > 0 && (
          <button
            className="text-muted-foreground text-xs hover:text-foreground transition-colors"
            onClick={() => setShowVersions((open) => !open)}
            type="button"
          >
            edited · {versions.length + 1} versions {showVersions ? "▴" : "▾"}
          </button>
        )}
      </div>

      {showVersions && versions.length > 0 && (
        <div className="mt-1 flex flex-col gap-2 rounded border border-border/40 bg-muted/30 p-2">
          {versions.map((version, index) => (
            <div className="flex flex-col gap-0.5" key={`${index}-${version.slice(0, 24)}`}>
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
    </div>
  );
}
