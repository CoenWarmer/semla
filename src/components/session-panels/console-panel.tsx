"use client";

import { ChevronDownIcon, ChevronUpIcon, TerminalIcon } from "lucide-react";
import dynamic from "next/dynamic";

import { BottomBarPanel } from "@/components/bottom-bar-panel";

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

/**
 * A real shell, running where the server runs, sharing the bottom bar's row
 * and panel area with the agent timeline, the branch graph and the element
 * picker via `BottomBarPanel` — see that component's doc comment for why.
 *
 * `keepMounted`, unlike those other panels: this owns a long-lived xterm
 * instance, a `ResizeObserver` and an SSE stream to the shell process.
 * Unmounting on collapse would dispose all three and lose scrollback, so the
 * terminal stays mounted once opened and is hidden rather than torn down.
 *
 * The panel keeps a fixed height rather than growing with content — a terminal
 * has no natural size, and one that resized itself as output arrived would
 * push the conversation around while you read it.
 */
export function ConsolePanel() {
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
      <AppTerminal />
    </BottomBarPanel>
  );
}
