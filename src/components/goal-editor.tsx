"use client";

import { TargetIcon } from "lucide-react";
import { useRef, useState } from "react";

interface GoalEditorProps {
  goal: string | null;
  onSave: (goal: string | null) => Promise<void>;
  /** Compact single-line variant for the topbar */
  variant?: "inline" | "block";
  /**
   * Open in edit mode with the field focused, so a goal can be typed without
   * clicking first.
   *
   * Left to the caller rather than defaulted on, because blurring commits: if
   * this opens over a goal that is already set, and the next thing typed was
   * meant for the prompt box, moving focus away saves that text as the goal.
   * Callers pass it when the field is empty and there is nothing to lose.
   */
  autoFocus?: boolean;
}

export function GoalEditor({
  autoFocus = false,
  goal,
  onSave,
  variant = "block",
}: GoalEditorProps) {
  const [editing, setEditing] = useState(autoFocus);
  const [draft, setDraft] = useState(goal ?? "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const startEdit = () => {
    setDraft(goal ?? "");
    setEditing(true);
    setTimeout(() => {
      textareaRef.current?.select();
      inputRef.current?.select();
    }, 0);
  };

  const commit = async () => {
    setEditing(false);
    const trimmed = draft.trim() || null;
    if (trimmed === (goal?.trim() || null)) return;
    await onSave(trimmed);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      setDraft(goal ?? "");
      setEditing(false);
    }
    if (e.key === "Enter" && (variant === "inline" || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void commit();
    }
  };

  if (variant === "inline") {
    return (
      <div className="flex min-w-0 items-center gap-1.5">
        <TargetIcon className="size-3.5 shrink-0 text-muted-foreground" />
        {editing ? (
          <input
            ref={inputRef}
            autoFocus
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            placeholder="Define your goal…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commit()}
            onKeyDown={handleKeyDown}
          />
        ) : (
          <button
            className="min-w-0 truncate text-sm text-muted-foreground hover:text-foreground transition-colors"
            onClick={startEdit}
            type="button"
          >
            {goal?.trim() ? (
              goal
            ) : (
              <span className="italic">No goal set — click to define one</span>
            )}
          </button>
        )}
      </div>
    );
  }

  // block variant — used in the prompt editor area
  return (
    <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 w-full">
      <div className="mb-1.5 flex items-center gap-1.5">
        <TargetIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Goal
        </span>
      </div>
      {editing ? (
        <textarea
          ref={textareaRef}
          autoFocus
          className="w-full resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          placeholder="What are you trying to achieve in this session?"
          rows={3}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={handleKeyDown}
        />
      ) : (
        <button
          className="w-full text-left text-sm text-muted-foreground hover:text-foreground transition-colors"
          onClick={startEdit}
          type="button"
        >
          {goal?.trim() ? (
            <span className="whitespace-pre-wrap">{goal}</span>
          ) : (
            <span className="italic">
              What are you trying to achieve? Click to define a goal…
            </span>
          )}
        </button>
      )}
      {editing && (
        <p className="mt-1 text-xs text-muted-foreground">
          {variant === "block"
            ? "⌘↵ to save · Esc to cancel"
            : "↵ to save · Esc to cancel"}
        </p>
      )}
    </div>
  );
}
