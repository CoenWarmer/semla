"use client";

import { ChevronsUpDownIcon } from "lucide-react";
import { useRef, type PointerEvent } from "react";

import {
  CONSOLE_BAR_HEIGHT,
  useBottomPanelHost,
} from "@/components/bottom-panel";
import { ConsolePanel } from "@/components/session-panels/console-panel";
import { SessionAgentsPanel } from "@/components/session-panels/session-agents-panel";
import { SessionBranchesPanel } from "@/components/session-panels/session-branches-panel";
import { ElementPicker } from "@/components/session-panels/element-picker";
import { cn } from "@/lib/utils";

/**
 * The strip along the foot of the app.
 *
 * This is pure bar chrome: the resize handle, the panel slot, the button row
 * and the expand control. It knows nothing about what any panel contains —
 * each panel (the console, the agent timeline, the branch graph, the element
 * picker) is an ordinary consumer of `useBottomPanelHost()`'s slots via
 * `BottomBarPanel`/`BottomBarButton` (bottom-bar-panel.tsx).
 *
 * The console is rendered first among the panel components below so that its
 * button, once portalled into the bar slot, lands leftmost in the row —
 * React appends portal children into a target node in the order their owning
 * components render, so mount order here is what fixes button order there.
 */
export function BottomBar() {
  const { height, open, resize, setBarSlot, setPanelSlot, toggleExpanded } =
    useBottomPanelHost();

  /**
   * Where the drag started, so a move can be measured against it.
   *
   * Pointer capture rather than window listeners: the handle keeps receiving
   * moves once it has the pointer, even as the cursor leaves it — which is the
   * normal case when dragging fast — and there is nothing to add or remove on
   * mount, so no effect and nothing to leak.
   */
  const drag = useRef<{ height: number; y: number } | null>(null);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { height, y: event.clientY };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start) return;
    // Upwards is taller: the panel grows from its top edge.
    resize(start.height + (start.y - event.clientY));
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <div className="shrink-0 border-t border-border/40 bg-background">
      {/*
        The handle sits above whichever panel is open, so both are resizable
        by the same grip rather than each growing one of its own.
      */}
      {open && (
        <hr
          aria-label="Resize panel"
          aria-orientation="horizontal"
          // `hr` rather than a div with role="separator": it is the native tag
          // for that role, which is what a splitter between two panes is.
          // Margins reset because a rule has generous ones by default.
          className="my-0 h-1 cursor-ns-resize border-0 bg-border/40 transition-colors hover:bg-primary/40"
          onPointerCancel={endDrag}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
        />
      )}

      {/*
        Where the open panel renders. Always in the tree, and given the panel
        height only when something is open, so the panel portalling into it
        does not have to know about the bar's layout.
      */}
      <div
        className={cn("border-b", open && "block", !open && "hidden")}
        ref={setPanelSlot}
        style={{ height }}
      />

      <div
        className="flex items-center gap-2 px-2 text-xs"
        style={{ height: CONSOLE_BAR_HEIGHT }}
      >
        {/*
          Mounted first so its button lands leftmost in the bar row: each of
          these portals its button into the same slot, and React appends a
          portal's children in the order its owning component renders.
        */}
        <ConsolePanel />
        <SessionAgentsPanel />
        <SessionBranchesPanel />
        <ElementPicker />

        {/* Where the panels above portal their buttons. */}
        <div className="flex items-center gap-2" ref={setBarSlot} />

        {/*
          One control for whichever panel is open, because the height is
          shared. Pushed right so it does not sit between the panel buttons.
        */}
        {open && (
          <button
            className="ml-auto flex items-center gap-1.5 rounded px-1 text-muted-foreground transition-colors hover:text-foreground"
            onClick={toggleExpanded}
            title="Expand the panel, or return it to its usual height"
            type="button"
          >
            <ChevronsUpDownIcon className="size-3" />
            Expand
          </button>
        )}
      </div>
    </div>
  );
}
