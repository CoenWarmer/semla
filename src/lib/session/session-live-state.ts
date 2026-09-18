/**
 * Live turn state mirrored into the query cache.
 *
 * The bottom bar (BottomBar, in layout.tsx, outside {children}) and the
 * panels that read session turn state used to portal into DOM slots the bar
 * owned, because that state lived in local useState inside usePromptMutation —
 * a sibling subtree, unreachable by a plain hook. Mirroring the live state into
 * the query cache (the same mechanism session-status.ts already uses for
 * sessionStatus) lets any layout-level component read it with a plain hook
 * instead.
 *
 * Every hook below is `enabled: false`, and that is load-bearing rather than
 * cosmetic. Each of these keys has exactly one real writer elsewhere
 * (`queryClient.setQueryData`) and these hooks exist only to observe it — the
 * `queryFn` is a placeholder that supplies a type and a value for a key
 * nothing has written yet. Leaving the query enabled meant React Query would
 * also treat that placeholder as a real fetch: on first mount, with no cached
 * data, it ran the `queryFn` and, some time after — always after, since
 * `Query.fetch()` calls `this.setData()` unconditionally once its own fetch
 * resolves, with no check for whether the cache already holds something
 * newer — overwrote whatever the real writer had just set with the
 * placeholder's `null`/`[]`/`false`. `staleTime: Infinity` stops this from
 * repeating on remount, which is exactly why it did not recover: the agent
 * timeline panel would come up permanently blank for a session whose
 * computed snapshot lost that race on the first render, and nothing after
 * that render ever ran `setQueryData` again to fix it. `enabled: false`
 * removes the placeholder fetch entirely; the observer still sees every
 * `setQueryData` write, since that notification path does not go through
 * `enabled` at all.
 */

import { useQuery } from "@tanstack/react-query";

import type { SessionToolCall } from "@/hooks/use-session-messages";
import type { AgentConsoleEntry } from "@/lib/session/agent-console";
import type { FileAccess } from "@/lib/pi/file-access/access-types";
import type { WorkflowSnapshot } from "@/types/workflow";

export const sessionLiveToolCallsKey = (sessionId: string) =>
  ["session-live-tool-calls", sessionId] as const;

/**
 * Files the running turn has read or written, as the events arrive.
 *
 * Kept apart from the history endpoint's timeline rather than merged into it:
 * these are attributed to `LIVE_TURN_ID` because the entries they describe are
 * not persisted yet, and writing them into the fetched timeline would leave the
 * cache holding records whose turn ids never resolve.
 */
export const sessionLiveAccessesKey = (sessionId: string) =>
  ["session-live-accesses", sessionId] as const;

/**
 * The agent's bash calls and their output, as the turn produces them.
 *
 * A key of its own rather than a field derived from `sessionLiveToolCallsKey`:
 * the console keeps far more output per call than a timeline row does, and the
 * bottom bar's console panel is a layout-level sibling of the session page, so
 * it can only reach live turn state through the cache. See agent-console.ts.
 */
export const sessionAgentConsoleKey = (sessionId: string) =>
  ["session-agent-console", sessionId] as const;

export const sessionAgentSelectionKey = (sessionId: string) =>
  ["session-agent-selection", sessionId] as const;

export const sessionPendingScrollKey = (sessionId: string) =>
  ["session-pending-scroll", sessionId] as const;

export const useSessionLiveToolCalls = (sessionId: string) =>
  useQuery({
    enabled: false,
    queryKey: sessionLiveToolCallsKey(sessionId),
    queryFn: (): SessionToolCall[] => [],
    staleTime: Number.POSITIVE_INFINITY,
  });

export const useSessionLiveAccesses = (sessionId: string) =>
  useQuery({
    enabled: false,
    queryKey: sessionLiveAccessesKey(sessionId),
    queryFn: (): FileAccess[] => [],
    staleTime: Number.POSITIVE_INFINITY,
  });

export const useSessionAgentConsole = (sessionId: string) =>
  useQuery({
    enabled: false,
    queryKey: sessionAgentConsoleKey(sessionId),
    queryFn: (): AgentConsoleEntry[] => [],
    staleTime: Number.POSITIVE_INFINITY,
  });

export const useSessionAgentSelection = (sessionId: string) =>
  useQuery({
    enabled: false,
    queryKey: sessionAgentSelectionKey(sessionId),
    queryFn: (): { agentId: number; runId: string } | null => null,
    staleTime: Number.POSITIVE_INFINITY,
  });

export const useSessionPendingScroll = (sessionId: string) =>
  useQuery({
    enabled: false,
    queryKey: sessionPendingScrollKey(sessionId),
    queryFn: (): string | null => null,
    staleTime: Number.POSITIVE_INFINITY,
  });

export const sessionWorkflowComputedSnapshotKey = (sessionId: string) =>
  ["session-workflow-computed-snapshot", sessionId] as const;

export const useSessionWorkflowComputedSnapshot = (sessionId: string) =>
  useQuery({
    enabled: false,
    queryKey: sessionWorkflowComputedSnapshotKey(sessionId),
    queryFn: (): WorkflowSnapshot | null => null,
    staleTime: Number.POSITIVE_INFINITY,
  });
