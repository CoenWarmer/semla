/**
 * Live turn state mirrored into the query cache.
 *
 * The bottom bar (AppConsole, in layout.tsx, outside {children}) and the
 * panels that read session turn state used to portal into DOM slots the bar
 * owned, because that state lived in local useState inside usePromptMutation —
 * a sibling subtree, unreachable by a plain hook. Mirroring the live state into
 * the query cache (the same mechanism session-status.ts already uses for
 * sessionStatus) lets any layout-level component read it with a plain hook
 * instead.
 */

import { useQuery } from "@tanstack/react-query";

import type { SessionToolCall } from "@/hooks/use-session-messages";
import type { LiveRound } from "@/lib/live-rounds";
import type { CodeMap } from "@/lib/code-map/types";
import type { WorkflowSnapshot } from "@/types/workflow";

export const sessionWorkflowSnapshotKey = (sessionId: string) =>
  ["session-workflow-snapshot", sessionId] as const;

export const sessionLiveToolCallsKey = (sessionId: string) =>
  ["session-live-tool-calls", sessionId] as const;

export const sessionLiveRoundsKey = (sessionId: string) =>
  ["session-live-rounds", sessionId] as const;

export const sessionRunningKey = (sessionId: string) =>
  ["session-running", sessionId] as const;

export const sessionCodeMapKey = (sessionId: string) =>
  ["session-code-map", sessionId] as const;

export const sessionActiveToolKey = (sessionId: string) =>
  ["session-active-tool", sessionId] as const;

export const sessionAgentSelectionKey = (sessionId: string) =>
  ["session-agent-selection", sessionId] as const;

export const sessionPendingScrollKey = (sessionId: string) =>
  ["session-pending-scroll", sessionId] as const;

export const useSessionWorkflowSnapshot = (sessionId: string) =>
  useQuery({
    queryKey: sessionWorkflowSnapshotKey(sessionId),
    queryFn: (): WorkflowSnapshot | undefined => undefined,
    staleTime: Number.POSITIVE_INFINITY,
  });

export const useSessionLiveToolCalls = (sessionId: string) =>
  useQuery({
    queryKey: sessionLiveToolCallsKey(sessionId),
    queryFn: (): SessionToolCall[] => [],
    staleTime: Number.POSITIVE_INFINITY,
  });

export const useSessionLiveRounds = (sessionId: string) =>
  useQuery({
    queryKey: sessionLiveRoundsKey(sessionId),
    queryFn: (): LiveRound[] => [],
    staleTime: Number.POSITIVE_INFINITY,
  });

export const useSessionRunning = (sessionId: string) =>
  useQuery({
    queryKey: sessionRunningKey(sessionId),
    queryFn: (): boolean => false,
    staleTime: Number.POSITIVE_INFINITY,
  });

export const useSessionCodeMap = (sessionId: string) =>
  useQuery({
    queryKey: sessionCodeMapKey(sessionId),
    queryFn: (): CodeMap | undefined => undefined,
    staleTime: Number.POSITIVE_INFINITY,
  });

export const useSessionActiveTool = (sessionId: string) =>
  useQuery({
    queryKey: sessionActiveToolKey(sessionId),
    queryFn: (): string | undefined => undefined,
    staleTime: Number.POSITIVE_INFINITY,
  });

export const useSessionAgentSelection = (sessionId: string) =>
  useQuery({
    queryKey: sessionAgentSelectionKey(sessionId),
    queryFn: (): { agentId: number; runId: string } | null => null,
    staleTime: Number.POSITIVE_INFINITY,
  });

export const useSessionPendingScroll = (sessionId: string) =>
  useQuery({
    queryKey: sessionPendingScrollKey(sessionId),
    queryFn: (): string | null => null,
    staleTime: Number.POSITIVE_INFINITY,
  });

export const sessionWorkflowComputedSnapshotKey = (sessionId: string) =>
  ["session-workflow-computed-snapshot", sessionId] as const;

export const useSessionWorkflowComputedSnapshot = (sessionId: string) =>
  useQuery({
    queryKey: sessionWorkflowComputedSnapshotKey(sessionId),
    queryFn: (): import("@/types/workflow").WorkflowSnapshot | undefined =>
      undefined,
    staleTime: Number.POSITIVE_INFINITY,
  });
