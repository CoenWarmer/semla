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
import { BrainIcon, ChevronDownIcon, XIcon } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { AgentHistoryEntry } from "@/lib/pi/workflow/workflow-run-reader";
import type { AgentDetail } from "@/lib/pi/workflow/workflow-service";
import {
  usePanelLayoutSaver,
  usePanelLayouts,
} from "@/hooks/use-panel-layout";
import { TokenUsage } from "@/components/token-usage";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const DRAWER_WIDTH_DEFAULT = 520
const DRAWER_WIDTH_MIN = 320
const DRAWER_WIDTH_MAX = 1000
const DRAWER_WIDTH_KEY = "agent-transcript-drawer-width"
/** Per arrow-key press on the resize handle; Shift multiplies it. */
const DRAWER_WIDTH_KEY_STEP = 16

/**
 * The route's response, described by the type the route actually returns.
 *
 * `agent` used to be restated here field by field, which is why this drawer
 * kept rendering without `historySource` after the route grew it: a hand-copied
 * shape does not fail to compile when the real one gains a member, it just
 * quietly stops carrying it. Type-only, so the server module it names is erased
 * and never bundled into this client component.
 */
type AgentData = {
  agent: AgentDetail;
  runId: string;
  workflowName: string;
};

function HistoryEntryRow({ entry }: { entry: AgentHistoryEntry }) {
  const isUser = entry.role === "user";
  const isTool = entry.kind === "toolCall" || entry.kind === "toolResult";

  // The point in the transcript where the agent lost sight of everything above
  // it. See the same branch in the agent detail page for why it is a rule
  // rather than a message.
  if (entry.kind === "compaction") {
    return (
      <div className="flex items-center gap-2 py-1">
        <div className="h-px flex-1 bg-amber-500/40" />
        <span className="text-xs uppercase tracking-wide text-amber-600 dark:text-amber-500">
          Context compacted
          {typeof entry.tokensBefore === "number"
            ? ` · ${entry.tokensBefore.toLocaleString()} tokens`
            : ""}
        </span>
        <div className="h-px flex-1 bg-amber-500/40" />
      </div>
    );
  }

  // Collapsed by default: reasoning explains why a turn went the way it did,
  // and is often longer than the turn itself.
  if (entry.kind === "thinking") {
    return (
      <Collapsible>
        <CollapsibleTrigger className="flex w-full items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors [&[data-state=open]>svg:last-child]:rotate-180">
          <BrainIcon className="size-3.5 shrink-0" />
          Thinking
          <ChevronDownIcon className="size-3.5 shrink-0 transition-transform" />
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-1.5 border-l-2 border-muted pl-3 text-sm text-muted-foreground">
          <span className="whitespace-pre-wrap break-words">{entry.text}</span>
        </CollapsibleContent>
      </Collapsible>
    );
  }

  if (isTool) {
    return (
      <div className="rounded-md bg-muted px-3 py-2 font-mono text-xs">
        <span className="text-muted-foreground">
          {entry.kind === "toolCall" ? `▶ ${entry.toolName}` : `◀ ${entry.toolName ?? "result"}`}
        </span>
        {/* Scrolled rather than clipped, matching the agent detail page: the
            drawer stays skimmable either way, but a hard slice put a second
            truncation on top of a record that exists precisely so nothing is
            truncated, with no way to reach the rest. */}
        {entry.text && (
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words text-foreground/80">
            {entry.text}
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
  // `null` means "nothing dragged yet this session" — width then follows
  // whatever was last saved, read at render time rather than synced in an
  // effect.
  const [widthOverride, setWidthOverride] = useState<number | null>(null)
  const savedWidth = usePanelLayouts().data?.[DRAWER_WIDTH_KEY] as
    | number
    | undefined
  const saveWidth = usePanelLayoutSaver(DRAWER_WIDTH_KEY)
  const drawerWidth = widthOverride ?? savedWidth ?? DRAWER_WIDTH_DEFAULT
  const drawerWidthRef = useRef(drawerWidth)
  useEffect(() => { drawerWidthRef.current = drawerWidth }, [drawerWidth])

  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = drawerWidthRef.current
    const onMouseMove = (ev: MouseEvent) => {
      const next = Math.max(DRAWER_WIDTH_MIN, Math.min(DRAWER_WIDTH_MAX, startWidth - (ev.clientX - startX)))
      setWidthOverride(next)
    }
    const onMouseUp = () => {
      window.removeEventListener("mousemove", onMouseMove)
      window.removeEventListener("mouseup", onMouseUp)
      saveWidth(drawerWidthRef.current)
    }
    window.addEventListener("mousemove", onMouseMove)
    window.addEventListener("mouseup", onMouseUp)
  }, [saveWidth])

  // Keyboard equivalent of the drag above, for the same handle — a resize
  // affordance with a mouse listener but no keyboard path is unusable
  // without one. Left/Right rather than Up/Down: the handle is vertical and
  // moving it left (this being the left edge) widens the drawer, matching
  // `startWidth - (ev.clientX - startX)` above.
  const handleResizeKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return
    e.preventDefault()
    const step = (e.shiftKey ? 3 : 1) * DRAWER_WIDTH_KEY_STEP
    const delta = e.key === "ArrowLeft" ? step : -step
    const next = Math.max(
      DRAWER_WIDTH_MIN,
      Math.min(DRAWER_WIDTH_MAX, drawerWidthRef.current + delta),
    )
    setWidthOverride(next)
    saveWidth(next)
  }, [saveWidth])

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
        {/* Left-edge resize handle — the ARIA "separator (window splitter)"
            pattern, so it is a real widget rather than a div a screen reader
            has no reason to stop on. */}
        <div
          aria-label="Resize agent transcript drawer"
          aria-orientation="vertical"
          aria-valuemax={DRAWER_WIDTH_MAX}
          aria-valuemin={DRAWER_WIDTH_MIN}
          aria-valuenow={drawerWidth}
          className="absolute inset-y-0 left-0 w-1 cursor-col-resize group/resize z-20"
          onKeyDown={handleResizeKeyDown}
          onMouseDown={handleResizeMouseDown}
          // The ARIA "separator (window splitter)" pattern, not a static
          // divider — `<hr>` cannot take a `tabIndex`, a keydown handler, or
          // `aria-valuenow`, all of which this actually-draggable handle
          // needs. The suggested tag fits the decorative case, not this one.
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
          role="separator"
          tabIndex={0}
        >
          <div className="absolute inset-y-0 left-0 w-px bg-border opacity-0 group-hover/resize:opacity-100 group-active/resize:opacity-100 transition-opacity" />
        </div>
        <DrawerHeader className="flex flex-row items-start justify-between gap-2 pb-3">
          <div className="min-w-0">
            <DrawerTitle className="truncate">
              {agent?.label ?? "Agent transcript"}
            </DrawerTitle>
            <DrawerDescription>
              {agent ? (
                <>
                  {agent.status}
                  {" · "}
                  <TokenUsage
                    cost={agent.cost}
                    emptyLabel="0 tokens"
                    tokens={agent.tokens}
                  />
                </>
              ) : query.isPending ? (
                "Loading…"
              ) : query.isError ? (
                "Failed to load"
              ) : (
                ""
              )}
            </DrawerDescription>
          </div>
          <DrawerClose className="shrink-0 rounded-sm p-1 opacity-70 hover:opacity-100">
            <XIcon className="size-4" />
          </DrawerClose>
        </DrawerHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4">
          {agent?.prompt && (
            <div className="mb-4 rounded-md border bg-card px-3 py-2 text-sm">
              <p className="text-muted-foreground text-xs mb-2">Prompt</p>
              <div className="prose prose-sm prose-invert max-w-none break-words [&_pre]:overflow-x-auto [&_code]:text-xs [&_p]:mb-2 [&_ul]:mb-2 [&_ol]:mb-2 [&_li]:mb-0.5">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {agent.prompt}
                </ReactMarkdown>
              </div>
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
              {agent.historySource === "run-file" && (
                <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-muted-foreground">
                  Partial — no session transcript was persisted for this agent,
                  so this is the run file&rsquo;s last {agent.history.length}{" "}
                  {agent.history.length === 1 ? "entry" : "entries"}, not the
                  whole run.
                </p>
              )}
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
