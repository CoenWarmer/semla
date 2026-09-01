"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  CircleCheckIcon,
  MoreHorizontalIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react";
import { GitStatusBadge } from "@/components/git-status-badge";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import type { SessionProject } from "@/lib/session-status";
import { Spinner } from "@/components/ui/spinner";
import { TokenUsage } from "@/components/token-usage";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** How many project chips a row shows before collapsing the rest into "+N". */
const VISIBLE_PROJECTS = 2;

interface SessionItemProps {
  id: string;
  date: string;
  /** The session has produced a transcript, so it has actually run. */
  hasRun?: boolean;
  isRunning?: boolean;
  /** Projects this session relates to, anchor first. */
  projects?: SessionProject[];
  title: string | null;
  usage?: { tokens: number; cost: number };
  onDelete: (id: string) => void;
}

export function SessionItem({
  id,
  date,
  hasRun,
  isRunning,
  projects = [],
  title,
  usage,
  onDelete,
}: SessionItemProps) {
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
          {projects.length > 0 && (
            // Names only — no branch, no counts, no popover. A row is one of
            // dozens, and GitStatusBadge would otherwise fetch on hover for
            // every project the pointer crossed on its way down the list.
            <span className="flex flex-wrap items-center gap-1">
              {projects.slice(0, VISIBLE_PROJECTS).map((project) => (
                <GitStatusBadge
                  key={project.path}
                  showBranchStatus={false}
                  showProjectName
                  target={{ kind: "project", path: project.absolutePath }}
                />
              ))}
              {projects.length > VISIBLE_PROJECTS && (
                <span
                  className="text-xs text-muted-foreground"
                  title={projects
                    .slice(VISIBLE_PROJECTS)
                    .map((project) => project.path)
                    .join(", ")}
                >
                  +{projects.length - VISIBLE_PROJECTS}
                </span>
              )}
            </span>
          )}
          {usage && (
            <TokenUsage
              className="text-xs"
              cost={usage.cost}
              tokens={usage.tokens}
            />
          )}
        </ItemDescription>
      </ItemContent>

      {/* Status sits above the stretched link and replaces the action menu.
          A finished session yields to the menu on hover, since its icon is a
          note about the past rather than something to wait on; a running one
          does not, because that is the thing being watched. */}
      {isRunning ? (
        <div className="relative z-10 ml-auto shrink-0">
          <Spinner className="size-4 text-muted-foreground" />
        </div>
      ) : (
        <>
          {hasRun && (
            <div
              aria-label="Completed"
              className="pointer-events-none absolute right-3 z-10 shrink-0 opacity-100 transition-opacity group-hover:opacity-0"
              title="Completed"
            >
              <CircleCheckIcon className="size-4 text-muted-foreground/70" />
            </div>
          )}
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
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => void handleDelete()}
                >
                  <Trash2Icon />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </>
      )}
    </Item>
  );
}
