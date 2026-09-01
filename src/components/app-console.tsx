"use client";

import { ChevronDownIcon, ChevronUpIcon, TerminalIcon } from "lucide-react";
import dynamic from "next/dynamic";
import { useState } from "react";

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

/** Collapsed height. Enough for the button and nothing more. */
const BAR_HEIGHT = "h-6";

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
  const [open, setOpen] = useState(false);
  // Mounted once opened and then left mounted, so collapsing the bar does not
  // tear down the emulator and reconnect on every toggle.
  const [everOpened, setEverOpened] = useState(false);

  const toggle = () => {
    setOpen((current) => !current);
    setEverOpened(true);
  };

  return (
    <div className="shrink-0 border-t border-border/40 bg-background">
      {everOpened && (
        <div className={cn("h-72 border-b", open ? "block" : "hidden")}>
          <AppTerminal />
        </div>
      )}

      <div className={cn("flex items-center gap-2 px-2 text-xs", BAR_HEIGHT)}>
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
      </div>
    </div>
  );
}
