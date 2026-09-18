"use client";

import { ChevronDownIcon, ChevronUpIcon, TerminalIcon } from "lucide-react";
import dynamic from "next/dynamic";
import { useState } from "react";

import { BottomBarPanel } from "@/components/bottom-bar-panel";
import { AgentConsole } from "@/components/session-panels/agent-console";
import { cn } from "@/lib/utils";

/**
 * Loaded only when the bar is first opened, and never on the server.
 *
 * xterm reaches for `document` as it loads, so it cannot be rendered during SSR
 * — and there is no reason for every page in the app to carry an emulator that
 * most visits never open.
 */
const AppTerminal = dynamic(
  () =>
    import("@/components/session-panels/app-terminal").then(
      (m) => m.AppTerminal,
    ),
  {
    loading: () => (
      <div className="flex h-full items-center px-3 text-xs text-muted-foreground">
        Starting a shell…
      </div>
    ),
    ssr: false,
  },
);

/** This panel's id in the shared bottom bar. See bottom-panel.tsx. */
const CONSOLE_PANEL = "console";

type ConsoleTab = "agent" | "shell";

/**
 * Two consoles in one panel, sharing the bottom bar's row and panel area with
 * the agent timeline, the branch graph and the element picker via
 * `BottomBarPanel` — see that component's doc comment for why.
 *
 * - **Agent** is what the session's agent has run: a read-only log of its bash
 *   calls and their output, live while a turn runs and reconstructed from the
 *   persisted transcript after a reload.
 * - **Shell** is a real interactive shell on the machine running the server.
 *
 * Two panes rather than one stream. Writing the agent's output into the
 * reader's own terminal would interleave with their typing and corrupt the
 * prompt line the shell is drawing, and the two have different needs anyway:
 * the agent's output arrives as cumulative snapshots that must replace what was
 * shown, which an emulator's append-only `write()` cannot express.
 *
 * `keepMounted`, unlike the other bottom panels: the shell tab owns a
 * long-lived xterm instance, a `ResizeObserver` and an SSE stream to a real
 * process. Unmounting on collapse would dispose all three and lose scrollback,
 * so the panel stays mounted once opened and is hidden rather than torn down.
 * The same reasoning applies to the tabs themselves — the inactive tab is
 * hidden, not unmounted, so switching to Agent and back does not kill the
 * shell.
 */
export function ConsolePanel() {
  const [tab, setTab] = useState<ConsoleTab>("agent");
  /**
   * Whether the shell tab has ever been selected.
   *
   * The terminal starts a real process on the server the moment it mounts, so
   * it is not started until asked for — opening the panel on the Agent tab
   * should not spawn a shell nobody looked at.
   */
  const [shellStarted, setShellStarted] = useState(false);

  const select = (next: ConsoleTab) => {
    setTab(next);
    if (next === "shell") setShellStarted(true);
  };

  return (
    <BottomBarPanel
      button={({ open, toggle }) => (
        <button
          aria-expanded={open}
          className="flex items-center gap-1.5 rounded px-1 text-muted-foreground transition-colors hover:text-foreground"
          onClick={toggle}
          type="button"
        >
          <TerminalIcon className="size-3" />
          Console
          {open ? (
            <ChevronDownIcon className="size-3" />
          ) : (
            <ChevronUpIcon className="size-3" />
          )}
        </button>
      )}
      keepMounted
      panelId={CONSOLE_PANEL}
    >
      <div className="flex h-full flex-col">
        <div
          aria-label="Console view"
          className="flex shrink-0 items-center gap-1 border-b border-border/40 px-2 py-1 text-xs"
          role="tablist"
        >
          <ConsoleTabButton
            active={tab === "agent"}
            label="Agent"
            onSelect={() => select("agent")}
          />
          <ConsoleTabButton
            active={tab === "shell"}
            label="Shell"
            onSelect={() => select("shell")}
          />
        </div>

        {/*
          Both panes stay in the tree once rendered — see the component comment.
          `hidden` rather than conditional rendering is also what keeps the
          terminal's own zero-size guard (app-terminal.tsx) relevant: a hidden
          host measures zero and must not be fitted to.
        */}
        <div className="min-h-0 flex-1">
          <div className={cn("h-full", tab !== "agent" && "hidden")} role="tabpanel">
            <AgentConsole />
          </div>
          {shellStarted && (
            <div className={cn("h-full", tab !== "shell" && "hidden")} role="tabpanel">
              <AppTerminal />
            </div>
          )}
        </div>
      </div>
    </BottomBarPanel>
  );
}

function ConsoleTabButton({
  active,
  label,
  onSelect,
}: {
  active: boolean;
  label: string;
  onSelect: () => void;
}) {
  return (
    <button
      aria-selected={active}
      className={cn(
        "rounded px-1.5 py-0.5 transition-colors",
        active
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
      onClick={onSelect}
      role="tab"
      type="button"
    >
      {label}
    </button>
  );
}
