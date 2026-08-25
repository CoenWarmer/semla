"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { MoreHorizontalIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { Item, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { TokenUsage } from "@/components/token-usage";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface SessionItemProps {
  id: string;
  date: string;
  title: string | null;
  usage?: { tokens: number; cost: number };
  onDelete: (id: string) => void;
}

export function SessionItem({ id, date, title, usage, onDelete }: SessionItemProps) {
  const router = useRouter();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(title ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  const startRename = () => {
    setDraft(title ?? "");
    setRenaming(true);
    // Focus after next paint
    setTimeout(() => inputRef.current?.select(), 0);
  };

  const commitRename = async () => {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === title) {
      setRenaming(false);
      return;
    }
    setRenaming(false);
    await fetch(`/api/sessions/${id}`, {
      body: JSON.stringify({ title: trimmed }),
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    });
    router.refresh();
  };

  const handleDelete = () => onDelete(id);

  return (
    <Item variant="outline" className="group relative">
      <ItemContent className="gap-1 min-w-0">
        <ItemTitle className="min-w-0">
          {renaming ? (
            <input
              ref={inputRef}
              autoFocus
              className="w-full bg-transparent text-sm outline-none"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") void commitRename();
                if (e.key === "Escape") setRenaming(false);
              }}
            />
          ) : (
            <Link
              href={`/sessions/${id}`}
              className="after:absolute after:inset-0"
            >
              {title ?? "Untitled"}
            </Link>
          )}
        </ItemTitle>
        <ItemDescription className="flex flex-col justify-between gap-1">
          <span>{date}</span>
          {usage && (
            <TokenUsage
              className="text-xs"
              cost={usage.cost}
              tokens={usage.tokens}
            />
          )}
        </ItemDescription>
      </ItemContent>

      {/* Trigger sits above the stretched link */}
      <div className="relative z-10 ml-auto shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
        <DropdownMenu>
          <DropdownMenuTrigger
            className="flex items-center justify-center rounded p-0.5 hover:bg-accent"
            aria-label="Session actions"
          >
            <MoreHorizontalIcon className="size-4 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="start">
            <DropdownMenuItem onClick={startRename}>
              <PencilIcon />
              Rename
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => void handleDelete()}>
              <Trash2Icon />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </Item>
  );
}
