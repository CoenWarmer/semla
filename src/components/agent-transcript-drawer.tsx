"use client";

import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { XIcon } from "lucide-react";
import type { AgentHistoryEntry } from "@/lib/pi/workflow-run-reader";

const DRAWER_WIDTH_DEFAULT = 520
const DRAWER_WIDTH_MIN = 320
const DRAWER_WIDTH_MAX = 1000

type AgentData = {
  agent: {
    endedAt?: string;
    error?: string;
    history: AgentHistoryEntry[];
    id: number;
    label: string;
    model?: string;
    phase?: string;
    prompt: string;
    startedAt?: string;
    status: string;
    tokens?: number;
  };
  runId: string;
  workflowName: string;
};

function HistoryEntryRow({ entry }: { entry: AgentHistoryEntry }) {
  const isUser = entry.role === "user";
  const isTool = entry.kind === "toolCall" || entry.kind === "toolResult";

  if (isTool) {
    return (
      <div className="rounded-md bg-muted px-3 py-2 font-mono text-xs">
        <span className="text-muted-foreground">
          {entry.kind === "toolCall" ? `▶ ${entry.toolName}` : `◀ ${entry.toolName ?? "result"}`}
        </span>
        {entry.text && (
          <pre className="mt-1 whitespace-pre-wrap break-words text-foreground/80">
            {entry.text.length > 500 ? entry.text.slice(0, 500) + "…" : entry.text}
          </pre>
        )}
      </div>
    );
  }

  return (
    <div className={isUser ? "text-muted-foreground text-sm" : "text-sm"}>
      {entry.kind === "error" && (
        <span className="text-destructive font-medium">Error: </span>
      )}
      <span className="whitespace-pre-wrap break-words">{entry.text}</span>
    </div>
  );
}

export function AgentTranscriptDrawer({
  agentId,
  onClose,
  open,
  runId,
  sessionId,
}: {
  agentId: number | null;
  onClose: () => void;
  open: boolean;
  runId: string | null;
  sessionId: string;
}) {
  const [drawerWidth, setDrawerWidth] = useState(DRAWER_WIDTH_DEFAULT)
  const drawerWidthRef = useRef(drawerWidth)
  useEffect(() => { drawerWidthRef.current = drawerWidth }, [drawerWidth])

  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = drawerWidthRef.current
    const onMouseMove = (ev: MouseEvent) => {
      const next = Math.max(DRAWER_WIDTH_MIN, Math.min(DRAWER_WIDTH_MAX, startWidth - (ev.clientX - startX)))
      setDrawerWidth(next)
    }
    const onMouseUp = () => {
      window.removeEventListener("mousemove", onMouseMove)
      window.removeEventListener("mouseup", onMouseUp)
    }
    window.addEventListener("mousemove", onMouseMove)
    window.addEventListener("mouseup", onMouseUp)
  }, [])

  const query = useQuery<AgentData>({
    enabled: open && agentId !== null && runId !== null,
    queryFn: async () => {
      const res = await fetch(
        `/api/sessions/${sessionId}/workflows/${runId}/agents/${agentId}`
      );
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    queryKey: ["agent-transcript", sessionId, runId, agentId],
    refetchInterval: (q) =>
      q.state.data?.agent.status === "running" ? 2000 : false,
  });

  const agent = query.data?.agent;

  return (
    <Drawer open={open} onOpenChange={(isOpen) => !isOpen && onClose()} swipeDirection="right" modal={false}>
      <DrawerContent
        className="flex flex-col overflow-hidden max-w-[90vw]"
        style={{ "--drawer-content-width": `${drawerWidth}px` } as React.CSSProperties}
      >
        {/* Left-edge resize handle */}
        <div
          onMouseDown={handleResizeMouseDown}
          className="absolute inset-y-0 left-0 w-1 cursor-col-resize group/resize z-20"
        >
          <div className="absolute inset-y-0 left-0 w-px bg-border opacity-0 group-hover/resize:opacity-100 group-active/resize:opacity-100 transition-opacity" />
        </div>
        <DrawerHeader className="flex flex-row items-start justify-between gap-2 pb-3">
          <div className="min-w-0">
            <DrawerTitle className="truncate">
              {agent?.label ?? "Agent transcript"}
            </DrawerTitle>
            <DrawerDescription>
              {agent
                ? `${agent.status} · ${agent.tokens?.toLocaleString() ?? "0"} tokens`
                : query.isPending
                  ? "Loading…"
                  : query.isError
                    ? "Failed to load"
                    : ""}
            </DrawerDescription>
          </div>
          <DrawerClose className="shrink-0 rounded-sm p-1 opacity-70 hover:opacity-100">
            <XIcon className="size-4" />
          </DrawerClose>
        </DrawerHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4">
          {agent?.prompt && (
            <div className="mb-4 rounded-md border bg-card px-3 py-2 text-sm">
              <p className="text-muted-foreground text-xs mb-1">Prompt</p>
              <p className="whitespace-pre-wrap break-words">{agent.prompt}</p>
            </div>
          )}

          {query.isPending && (
            <p className="text-muted-foreground text-sm">Loading transcript…</p>
          )}
          {query.isError && (
            <p className="text-destructive text-sm">
              {query.error instanceof Error ? query.error.message : "Unknown error"}
            </p>
          )}

          {agent?.history && agent.history.length > 0 && (
            <div className="flex flex-col gap-3">
              {agent.history.map((entry, i) => (
                <HistoryEntryRow key={i} entry={entry} />
              ))}
            </div>
          )}

          {agent && agent.history?.length === 0 && (
            <p className="text-muted-foreground text-sm">No history yet.</p>
          )}

          {agent?.error && (
            <div className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-sm">
              {agent.error}
            </div>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
}
