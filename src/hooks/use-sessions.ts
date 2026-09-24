"use client";

import { useQuery } from "@tanstack/react-query";

// Type-only: `session-list.ts` reads the filesystem and is server-only. A
// value import would drag `node:fs` into the client bundle; the type is
// erased at compile time and costs nothing.
import type { SessionListRow } from "@/lib/pi/session/session-list";

export type { SessionListRow };

export const sessionsQueryKey = ["sessions"] as const;

const fetchSessions = async (): Promise<SessionListRow[]> => {
  const response = await fetch("/api/sessions");

  if (!response.ok) {
    throw new Error("Unable to load sessions.");
  }

  const { sessions } = (await response.json()) as { sessions: SessionListRow[] };
  return sessions;
};

/**
 * Every session belonging to the current user, newest first.
 *
 * `enabled` defaults to true but is exposed so a picker that only reveals the
 * list inside a popover — like `SessionsCombobox` — can defer the request
 * until it actually opens, the same way `ProjectsCombobox` defers its own
 * fetch of `/api/projects`.
 */
export const useSessions = ({ enabled = true }: { enabled?: boolean } = {}) =>
  useQuery({
    enabled,
    queryFn: fetchSessions,
    queryKey: sessionsQueryKey,
  });
