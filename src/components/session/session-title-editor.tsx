"use client";

import { useEffect, useRef, useState } from "react";

interface SessionTitleEditorProps {
  title: string | null;
  onSave: (title: string) => Promise<void>;
}

/**
 * Click-to-rename session title, styled to sit where the plain `<h1>` used
 * to. Same edit/commit shape as GoalEditor's inline variant — click to open
 * a text field, Enter or blur commits, Escape reverts — but kept as its own
 * component rather than folded into GoalEditor: a title is never cleared to
 * empty (the PATCH route rejects a blank title, see route.ts), where a goal
 * can be, so the commit rule genuinely differs.
 */
export function SessionTitleEditor({ onSave, title }: SessionTitleEditorProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // Captured from the button just before swapping it for the input, so the
  // field opens at the title's own rendered width instead of the flex
  // parent's default — an unset input would stretch to fill the row's
  // remaining space and the title would visibly jump wider on click.
  const [width, setWidth] = useState<number | null>(null);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  const startEdit = () => {
    setWidth(buttonRef.current?.getBoundingClientRect().width ?? null);
    setDraft(title ?? "");
    setEditing(true);
  };

  const commit = async () => {
    setEditing(false);
    const trimmed = draft.trim();
    // A blank title is not a valid state to save — the PATCH route ignores
    // an empty string, so reverting here keeps the field's own state in
    // sync with what the server will actually keep.
    if (!trimmed || trimmed === title?.trim()) return;
    await onSave(trimmed);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      setDraft(title ?? "");
      setEditing(false);
    }
    if (e.key === "Enter") {
      e.preventDefault();
      void commit();
    }
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="max-w-300 min-w-0 bg-transparent text-center text-xs font-medium text-foreground outline-none"
        onBlur={() => void commit()}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        style={width !== null ? { width } : undefined}
        value={draft}
      />
    );
  }

  return (
    <button
      ref={buttonRef}
      className="max-w-300 min-w-0 truncate text-xs font-medium text-foreground hover:text-muted-foreground transition-colors"
      onClick={startEdit}
      title="Click to rename this session"
      type="button"
    >
      {title ?? "Untitled session"}
    </button>
  );
}
