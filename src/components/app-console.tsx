"use client";

import {
  ChevronDownIcon,
  ChevronsUpDownIcon,
  ChevronUpIcon,
  TerminalIcon,
} from "lucide-react";
import dynamic from "next/dynamic";
import { useRef, useState, type PointerEvent } from "react";

import {
  CONSOLE_BAR_HEIGHT,
  useBottomPanelHost,
} from "@/components/bottom-panel";
import { cn } from "@/lib/utils";

/**
 * Loaded only when the bar is first opened, and never on the server.
 *
 * xterm reaches for `document` as it loads, so it cannot be rendered during SSR
 * — and there is no reason for every page in the app to carry an emulator that
 * most visits never open.
 */
const AppTerminal = dynamic(
  () => import("@/components/app-terminal").then((m) => m.AppTerminal),
  {
    loading: () => (
      <div className="flex h-full items-center px-3 text-xs text-muted-foreground">
        Starting a shell…
      </div>
    ),
    ssr: false,
  },
);

/** The console's id in the shared bar. See bottom-panel.tsx. */
const CONSOLE_PANEL = "console";

/**
 * The strip along the foot of the app, and the shell inside it.
 *
 * It used to expand into a read-only view of the agent's tool-call names. That
 * was a placeholder for this: a real terminal on the machine running the
 * server, which is what the bar is for.
 *
 * The panel keeps a fixed height rather than growing with content — a terminal
 * has no natural size, and one that resized itself as output arrived would
 * push the conversation around while you read it.
 */
export function AppConsole() {
  const {
    height,
    open,
    resize,
    setBarSlot,
    setPanelSlot,
    toggle,
    toggleExpanded,
  } = useBottomPanelHost();
  const consoleOpen = open === CONSOLE_PANEL;
  // Mounted once opened and then left mounted, so collapsing the bar does not
  // tear down the emulator and reconnect on every toggle.
  const [everOpened, setEverOpened] = useState(false);

  const toggleConsole = () => {
    toggle(CONSOLE_PANEL);
    setEverOpened(true);
  };

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

      {everOpened && (
        <div
          className={cn("border-b", consoleOpen ? "block" : "hidden")}
          style={{ height }}
        >
          <AppTerminal />
        </div>
      )}

      {/*
        Where a page's own panel renders. Always in the tree, and given the
        panel height only when something is open, so the page portalling into
        it does not have to know about the bar's layout.
      */}
      <div
        className={cn("border-b", open && !consoleOpen ? "block" : "hidden")}
        ref={setPanelSlot}
        style={{ height }}
      />

      <div
        className="flex items-center gap-2 px-2 text-xs"
        style={{ height: CONSOLE_BAR_HEIGHT }}
      >
        <button
          aria-expanded={consoleOpen}
          className="flex items-center gap-1.5 rounded px-1 text-muted-foreground transition-colors hover:text-foreground"
          onClick={toggleConsole}
          type="button"
        >
          <TerminalIcon className="size-3" />
          Console
          {consoleOpen ? (
            <ChevronDownIcon className="size-3" />
          ) : (
            <ChevronUpIcon className="size-3" />
          )}
        </button>

        {/* Buttons the current page contributes, beside the console's own. */}
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
