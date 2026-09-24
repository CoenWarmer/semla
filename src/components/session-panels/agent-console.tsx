"use client";

import { useEffect, useMemo, useRef } from "react";
import { useParams } from "next/navigation";

import { useSessionMessagesReader } from "@/hooks/use-session-messages";
import {
  agentConsoleFromToolCalls,
  mergeAgentConsole,
  stripAnsi,
  type AgentConsoleEntry,
} from "@/lib/session/agent-console";
import { useSessionAgentConsole } from "@/lib/session/session-live-state";

const EMPTY: AgentConsoleEntry[] = [];

/**
 * How long a command ran, once it has finished.
 *
 * Milliseconds below a second, because most of what the agent runs is a grep
 * that returns immediately and "0s" says less than "180ms".
 */
const duration = (entry: AgentConsoleEntry): string | null => {
  if (!entry.endedAt) return null;
  const ms = Date.parse(entry.endedAt) - Date.parse(entry.startedAt);
  if (!Number.isFinite(ms) || ms < 0) return null;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
};

/**
 * The bash commands the agent has run in this session, and their output.
 *
 * Read-only, and deliberately not an xterm. The agent's bash runs on a pipe
 * rather than a tty: there is no cursor addressing to emulate and nothing
 * redraws, so this is a transcript. It also has to be *replaceable* rather than
 * append-only — pi reports a running command's output cumulatively (see
 * agent-console.ts) — which an emulator's write-only stream cannot express.
 *
 * Two sources merged: the live stream while a turn runs, and the persisted
 * tool-call rows after a reload. `mergeAgentConsole` prefers the live copy,
 * which keeps more of each command's output than a persisted tool result does.
 */
export function AgentConsole() {
  const { id } = useParams<{ id?: string }>();
  const sessionId = id ?? "";

  const liveQuery = useSessionAgentConsole(sessionId);
  const messagesQuery = useSessionMessagesReader(sessionId);

  const entries = useMemo(
    () =>
      mergeAgentConsole(
        agentConsoleFromToolCalls(messagesQuery.data?.toolCalls ?? []),
        liveQuery.data ?? EMPTY,
      ),
    [liveQuery.data, messagesQuery.data?.toolCalls],
  );

  const scrollRef = useRef<HTMLDivElement>(null);

  /**
   * Follow the tail, unless the reader has scrolled away from it.
   *
   * The check is read from the DOM at the moment output arrives rather than
   * tracked as state: "is the reader at the bottom" is a property of the
   * scroller, and mirroring it into React state would be a second copy that
   * `react/set-state-in-effect` rightly objects to.
   */
  useEffect(() => {
    const host = scrollRef.current;
    if (!host) return;
    const distanceFromBottom =
      host.scrollHeight - host.scrollTop - host.clientHeight;
    if (distanceFromBottom < 80) host.scrollTop = host.scrollHeight;
  }, [entries]);

  if (!sessionId) {
    return (
      <div className="flex h-full items-center px-3 text-xs text-muted-foreground">
        Open a session to see the commands its agent runs.
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="flex h-full items-center px-3 text-xs text-muted-foreground">
        The agent has not run a command in this session yet.
      </div>
    );
  }

  return (
    <div
      className="h-full overflow-y-auto bg-[#09090b] px-3 py-2 font-mono text-xs leading-relaxed text-zinc-200"
      ref={scrollRef}
    >
      {entries.map((entry) => {
        const ran = duration(entry);
        return (
          <div className="mb-3 last:mb-0" key={entry.toolCallId}>
            <div className="flex items-baseline gap-2">
              <span
                aria-hidden
                className={
                  entry.isError
                    ? "text-red-400"
                    : entry.endedAt
                      ? "text-emerald-400"
                      : "animate-pulse text-amber-400"
                }
              >
                $
              </span>
              <span className="min-w-0 flex-1 break-all whitespace-pre-wrap text-zinc-100">
                {entry.command}
              </span>
              {ran && <span className="shrink-0 text-zinc-500">{ran}</span>}
            </div>
            {entry.output && (
              <pre className="mt-1 break-all whitespace-pre-wrap text-zinc-400">
                {stripAnsi(entry.output)}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}
