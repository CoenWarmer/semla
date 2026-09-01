"use client";

import { ChevronDownIcon, ChevronUpIcon, TerminalIcon } from "lucide-react";
import { useState, useSyncExternalStore } from "react";

import { Terminal } from "@/components/ai-elements/terminal";
import {
  clearConsole,
  formatConsole,
  getConsoleLines,
  subscribeToConsole,
} from "@/lib/console-log";
import { cn } from "@/lib/utils";

/** Collapsed height. Enough for one line of text and nothing more. */
const BAR_HEIGHT = "h-6";

export function AppConsole() {
  const [open, setOpen] = useState(false);

  const lines = useSyncExternalStore(
    subscribeToConsole,
    getConsoleLines,
    // The server renders no lines; the store only exists in the browser.
    () => EMPTY,
  );

  const latest = lines.at(-1);

  return (
    <div className="shrink-0 border-t border-border/40 bg-background">
      {open && (
        <Terminal
          className="max-h-72 rounded-none border-0 border-b"
          onClear={clearConsole}
          output={formatConsole(lines)}
        />
      )}

      <div className={cn("flex items-center gap-2 px-2 text-xs", BAR_HEIGHT)}>
        <button
          aria-expanded={open}
          className="flex items-center gap-1.5 rounded px-1 text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => setOpen((current) => !current)}
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

        {/* Collapsed, the bar is still worth its 24px: it shows the last line,
            so the agent's current step is visible without opening anything. */}
        {!open && latest && (
          <span className="truncate font-mono text-muted-foreground/70">
            {latest.kind === "command" ? `$ ${latest.text}` : latest.text}
          </span>
        )}

        {lines.length > 0 && (
          <span className="ml-auto shrink-0 tabular-nums text-muted-foreground/50">
            {lines.length}
          </span>
        )}
      </div>
    </div>
  );
}

/** Stable identity: a new array here would loop useSyncExternalStore forever. */
const EMPTY: ReturnType<typeof getConsoleLines> = [];
